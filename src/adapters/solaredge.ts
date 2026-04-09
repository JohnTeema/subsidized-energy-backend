import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

const BASE_URL = 'https://monitoringapi.solaredge.com';

// Rate limit: 300 requests per day — track per API key
const dailyCallCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_DAILY_CALLS = 300;

function checkRateLimit(apiKey: string): void {
  const now = Date.now();
  const entry = dailyCallCounts.get(apiKey);
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);

  if (!entry || now >= entry.resetAt) {
    dailyCallCounts.set(apiKey, { count: 1, resetAt: midnight.getTime() });
    return;
  }
  if (entry.count >= MAX_DAILY_CALLS) {
    throw new Error(
      `SolarEdge rate limit reached (${MAX_DAILY_CALLS}/day). Resets at midnight.`,
    );
  }
  entry.count++;
}

async function fetchWithRetry<T>(
  url: string,
  params: Record<string, string>,
  retries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.get<T>(url, { params, timeout: 15_000 });
      return res.data;
    } catch (err) {
      lastError = err;
      if (err instanceof AxiosError && err.response?.status === 429) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt + 1) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface SolarEdgeEnergyResponse {
  energy: {
    unit: string;
    values: Array<{ date: string; value: number | null }>;
  };
}

interface SolarEdgeDetailsResponse {
  details: {
    peakPower: number;
    location: { lat: number; lng: number };
  };
}

export class SolarEdgeAdapter implements InverterAdapter {
  async fetchEnergy(
    credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading> {
    const { apiKey, siteId } = credentials;
    if (!apiKey || !siteId) throw new Error('SolarEdge requires apiKey and siteId credentials');

    checkRateLimit(apiKey);

    const data = await fetchWithRetry<SolarEdgeEnergyResponse>(
      `${BASE_URL}/site/${siteId}/energy`,
      {
        startDate: formatDate(intervalStart),
        endDate: formatDate(intervalEnd),
        timeUnit: 'QUARTER_OF_AN_HOUR',
        api_key: apiKey,
      },
    );

    const values = data.energy?.values ?? [];
    const intervalEndStr = intervalEnd.toISOString().slice(0, 16).replace('T', ' '); // "YYYY-MM-DD HH:MM"

    // Find the value matching our interval end (API returns 15-min slots)
    const match = values.find(v => v.date.startsWith(intervalEndStr.slice(0, 15))) ?? values[values.length - 1];
    const wh = match?.value ?? 0;
    const kwh = (wh ?? 0) / 1000;

    const rawHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');

    let rated_capacity_kw = 5.0;
    let latitude = 0;
    let longitude = 0;
    try {
      const details = await this.fetchSiteDetails(credentials);
      rated_capacity_kw = details.rated_capacity_kw;
      latitude = details.latitude;
      longitude = details.longitude;
    } catch {
      // non-fatal — site details are nice-to-have
    }

    return {
      producer_id: producerId,
      inverter_id: inverterId,
      brand: 'solaredge',
      kwh_produced: parseFloat(kwh.toFixed(4)),
      interval_start: intervalStart.toISOString(),
      interval_end: intervalEnd.toISOString(),
      rated_capacity_kw,
      latitude,
      longitude,
      raw_hash: rawHash,
    };
  }

  async fetchSiteDetails(credentials: Record<string, string>): Promise<SiteDetails> {
    const { apiKey, siteId } = credentials;
    if (!apiKey || !siteId) throw new Error('SolarEdge requires apiKey and siteId');

    checkRateLimit(apiKey);

    const data = await fetchWithRetry<SolarEdgeDetailsResponse>(
      `${BASE_URL}/site/${siteId}/details`,
      { api_key: apiKey },
    );

    return {
      rated_capacity_kw: data.details?.peakPower ?? 5.0,
      latitude: data.details?.location?.lat ?? 0,
      longitude: data.details?.location?.lng ?? 0,
    };
  }

  async testConnection(credentials: Record<string, string>): Promise<ConnectionTestResult> {
    const { apiKey, siteId } = credentials;
    if (!apiKey) return { success: false, message: 'apiKey is required' };
    if (!siteId) return { success: false, message: 'siteId is required' };

    try {
      await fetchWithRetry<SolarEdgeDetailsResponse>(
        `${BASE_URL}/site/${siteId}/details`,
        { api_key: apiKey },
        1,
      );
      return { success: true, message: 'SolarEdge connection verified' };
    } catch (err) {
      const msg = err instanceof AxiosError
        ? `HTTP ${err.response?.status}: ${err.response?.data?.message ?? err.message}`
        : String(err);
      return { success: false, message: `SolarEdge connection failed: ${msg}` };
    }
  }
}
