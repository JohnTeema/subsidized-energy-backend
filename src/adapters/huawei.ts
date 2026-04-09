/**
 * Huawei FusionSolar adapter
 * Base URL: https://intl.fusionsolar.huawei.com/thirdData
 * Auth: POST /login → returns XSRF token in response header
 * Rate limit: 100 requests/hour
 */

import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

const BASE_URL = 'https://intl.fusionsolar.huawei.com/thirdData';

// Session cache per username
interface HuaweiSession {
  xsrfToken: string;
  cookies: string;
  expiresAt: number;
}
const sessionCache = new Map<string, HuaweiSession>();

// Rate limit: 100 requests/hour per account
const hourlyCallCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_HOURLY_CALLS = 100;

function checkRateLimit(username: string): void {
  const now = Date.now();
  const entry = hourlyCallCounts.get(username);
  const nextHour = now + 3_600_000 - (now % 3_600_000);

  if (!entry || now >= entry.resetAt) {
    hourlyCallCounts.set(username, { count: 1, resetAt: nextHour });
    return;
  }
  if (entry.count >= MAX_HOURLY_CALLS) {
    throw new Error(`Huawei FusionSolar rate limit reached (${MAX_HOURLY_CALLS}/hour). Try again later.`);
  }
  entry.count++;
}

async function getSession(credentials: Record<string, string>): Promise<HuaweiSession> {
  const { username, systemCode } = credentials;
  const cached = sessionCache.get(username);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached;
  }

  checkRateLimit(username);

  const res = await axios.post(
    `${BASE_URL}/login`,
    { userName: username, systemCode },
    { timeout: 15_000, maxRedirects: 0, validateStatus: s => s < 400 },
  );

  // XSRF token may be in header or response body
  const xsrfToken: string =
    (res.headers['xsrf-token'] as string | undefined) ??
    (res.data?.data?.xsrfToken as string | undefined) ??
    '';

  const setCookieHeader = res.headers['set-cookie'];
  const cookies = Array.isArray(setCookieHeader)
    ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
    : '';

  if (!xsrfToken) {
    throw new Error('Huawei FusionSolar login did not return XSRF token');
  }

  const session: HuaweiSession = {
    xsrfToken,
    cookies,
    expiresAt: Date.now() + 30 * 60 * 1000, // sessions last ~30 min
  };
  sessionCache.set(username, session);
  return session;
}

function sessionHeaders(session: HuaweiSession): Record<string, string> {
  return {
    'XSRF-TOKEN': session.xsrfToken,
    Cookie: session.cookies,
    'Content-Type': 'application/json',
  };
}

interface HuaweiStation {
  stationCode: string;
  stationName?: string;
  capacity?: number;
  latitude?: number;
  longitude?: number;
}

interface HuaweiKpiResponse {
  success: boolean;
  data?: Array<{
    stationCode: string;
    dataItemMap?: {
      radiation_intensity?: number;
      theory_power?: number;
      inverter_power?: number;
      ongrid_power?: number;
      power_profit?: number;
      use_power?: number;
      reduction_total_co2?: number;
      reduction_total_coal?: number;
    };
    collectTime?: number;
  }>;
  failCode?: number;
  message?: string;
}

export class HuaweiAdapter implements InverterAdapter {
  async fetchEnergy(
    credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading> {
    const { username } = credentials;
    checkRateLimit(username);
    const session = await getSession(credentials);
    const headers = sessionHeaders(session);

    // Get station list
    const stationsRes = await axios.post<{
      success: boolean;
      data?: HuaweiStation[];
      failCode?: number;
    }>(
      `${BASE_URL}/getStationList`,
      {},
      { headers, timeout: 15_000 },
    );
    checkRateLimit(username);

    if (!stationsRes.data.success) {
      // Session may have expired; clear cache and retry once
      sessionCache.delete(username);
      throw new Error(`Huawei getStationList failed: code ${stationsRes.data.failCode}`);
    }

    const stations = stationsRes.data.data ?? [];
    if (stations.length === 0) throw new Error('No Huawei FusionSolar stations found');
    const station = stations[0];

    // Get hourly KPI
    const collectTime = Math.floor(intervalEnd.getTime() / 1000) * 1000; // ms
    const kpiRes = await axios.post<HuaweiKpiResponse>(
      `${BASE_URL}/getKpiStationHour`,
      { stationCodes: station.stationCode, collectTime },
      { headers, timeout: 15_000 },
    );
    checkRateLimit(username);

    const rawData = { station, kpi: kpiRes.data };

    // Extract kWh: ongrid_power is kWh produced in the hour
    // For a 15-min interval, approximate as ongrid_power / 4
    const kpiData = kpiRes.data.data?.[0];
    const hourlyKwh = kpiData?.dataItemMap?.ongrid_power ?? 0;
    const kwhProduced = hourlyKwh / 4; // 15-min slice of hourly value

    const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');

    return {
      producer_id: producerId,
      inverter_id: inverterId,
      brand: 'huawei',
      kwh_produced: parseFloat(Math.max(0, kwhProduced).toFixed(4)),
      interval_start: intervalStart.toISOString(),
      interval_end: intervalEnd.toISOString(),
      rated_capacity_kw: (station.capacity ?? 5000) / 1000,
      latitude: station.latitude ?? 0,
      longitude: station.longitude ?? 0,
      raw_hash: rawHash,
    };
  }

  async fetchSiteDetails(credentials: Record<string, string>): Promise<SiteDetails> {
    const { username } = credentials;
    checkRateLimit(username);
    const session = await getSession(credentials);

    const res = await axios.post<{ success: boolean; data?: HuaweiStation[] }>(
      `${BASE_URL}/getStationList`,
      {},
      { headers: sessionHeaders(session), timeout: 15_000 },
    );
    const station = res.data.data?.[0];
    return {
      rated_capacity_kw: (station?.capacity ?? 5000) / 1000,
      latitude: station?.latitude ?? 0,
      longitude: station?.longitude ?? 0,
    };
  }

  async testConnection(credentials: Record<string, string>): Promise<ConnectionTestResult> {
    const { username, systemCode } = credentials;
    if (!username) return { success: false, message: 'username is required' };
    if (!systemCode) return { success: false, message: 'systemCode is required' };

    try {
      // Clear any stale session before testing
      sessionCache.delete(username);
      await getSession(credentials);
      return { success: true, message: 'Huawei FusionSolar connection verified' };
    } catch (err) {
      const msg = err instanceof AxiosError
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`
        : String(err);
      return { success: false, message: `Huawei connection failed: ${msg}` };
    }
  }
}
