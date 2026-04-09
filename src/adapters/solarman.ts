/**
 * Deye / Solarman adapter
 * API base: https://globalapi.solarmanpv.com
 * Auth: appId + SHA256(appSecret + password) → POST /account/v1.0/token
 */

import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

const BASE_URL = 'https://globalapi.solarmanpv.com';

// Token cache: keyed by appId+email
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function sha256(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function cacheKey(credentials: Record<string, string>): string {
  return `${credentials.appId}:${credentials.email}`;
}

async function getToken(credentials: Record<string, string>): Promise<string> {
  const key = cacheKey(credentials);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const { appId, appSecret, email, password } = credentials;
  const hashedPassword = sha256(password);

  const res = await axios.post<{
    access_token: string;
    expires_in: number;
    code: string;
    msg?: string;
  }>(
    `${BASE_URL}/account/v1.0/token?appId=${appId}&language=en`,
    { appSecret, email, password: hashedPassword },
    { timeout: 15_000 },
  );

  if (res.data.code !== '0' && res.data.code !== 'SUCCESS') {
    throw new Error(`Solarman auth failed: ${res.data.msg ?? res.data.code}`);
  }

  const token = res.data.access_token;
  const expiresIn = res.data.expires_in ?? 7200;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface SolarmanStation {
  id: number;
  name: string;
  locationLat?: number;
  locationLng?: number;
  installedCapacity?: number;
}

interface SolarmanDevice {
  deviceSn: string;
  deviceType?: string;
}

interface SolarmanHistoricalData {
  code: string;
  msg?: string;
  paramDataList?: Array<{
    collectTime: number;
    dataList: Array<{ key: string; value: string }>;
  }>;
}

export class SolarmanAdapter implements InverterAdapter {
  async fetchEnergy(
    credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading> {
    const token = await getToken(credentials);
    const headers = authHeaders(token);

    // Get station list
    const stationsRes = await axios.post<{
      code: string;
      msg?: string;
      stationList?: SolarmanStation[];
    }>(
      `${BASE_URL}/station/v1.0/list`,
      { page: 1, size: 10 },
      { headers, timeout: 15_000 },
    );

    const stations = stationsRes.data.stationList ?? [];
    if (stations.length === 0) throw new Error('No Solarman stations found');
    const station = stations[0];

    // Get device list for station
    const devicesRes = await axios.post<{
      code: string;
      deviceListItems?: SolarmanDevice[];
    }>(
      `${BASE_URL}/station/v1.0/device`,
      { stationId: station.id },
      { headers, timeout: 15_000 },
    );
    const devices = devicesRes.data.deviceListItems ?? [];
    if (devices.length === 0) throw new Error('No Solarman devices found');
    const device = devices[0];

    // Fetch historical data for the interval
    const collectTime = Math.floor(intervalEnd.getTime() / 1000);
    const histRes = await axios.post<SolarmanHistoricalData>(
      `${BASE_URL}/device/v1.0/historical`,
      { deviceSn: device.deviceSn, collectTime, timeType: 2 }, // timeType 2 = 5-min data
      { headers, timeout: 15_000 },
    );

    const rawData = { station, device, historical: histRes.data };

    // Extract kWh from historical data
    // Look for total generation key in the interval window
    const startTs = Math.floor(intervalStart.getTime() / 1000);
    const endTs = Math.floor(intervalEnd.getTime() / 1000);
    const dataPoints = (histRes.data.paramDataList ?? []).filter(
      p => p.collectTime >= startTs && p.collectTime <= endTs,
    );

    let kwhProduced = 0;
    if (dataPoints.length > 0) {
      // Sum AC power readings and convert to kWh (P * dt)
      for (const point of dataPoints) {
        const acPowerItem = point.dataList?.find(d =>
          d.key === 'AC_ACTIVE_POWER_R' || d.key === 'AC_POWER' || d.key === 'P_AC',
        );
        if (acPowerItem) {
          const powerKw = parseFloat(acPowerItem.value) / 1000; // W → kW
          kwhProduced += powerKw * (5 / 60); // 5-min intervals
        }
      }
    }

    const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');

    return {
      producer_id: producerId,
      inverter_id: inverterId,
      brand: 'deye',
      kwh_produced: parseFloat(Math.max(0, kwhProduced).toFixed(4)),
      interval_start: intervalStart.toISOString(),
      interval_end: intervalEnd.toISOString(),
      rated_capacity_kw: (station.installedCapacity ?? 5000) / 1000,
      latitude: station.locationLat ?? 0,
      longitude: station.locationLng ?? 0,
      raw_hash: rawHash,
    };
  }

  async fetchSiteDetails(credentials: Record<string, string>): Promise<SiteDetails> {
    const token = await getToken(credentials);
    const res = await axios.post<{ stationList?: SolarmanStation[] }>(
      `${BASE_URL}/station/v1.0/list`,
      { page: 1, size: 10 },
      { headers: authHeaders(token), timeout: 15_000 },
    );
    const station = res.data.stationList?.[0];
    return {
      rated_capacity_kw: (station?.installedCapacity ?? 5000) / 1000,
      latitude: station?.locationLat ?? 0,
      longitude: station?.locationLng ?? 0,
    };
  }

  async testConnection(credentials: Record<string, string>): Promise<ConnectionTestResult> {
    const { appId, appSecret, email, password } = credentials;
    if (!appId) return { success: false, message: 'appId is required' };
    if (!appSecret) return { success: false, message: 'appSecret is required' };
    if (!email) return { success: false, message: 'email is required' };
    if (!password) return { success: false, message: 'password is required' };

    try {
      await getToken(credentials);
      return { success: true, message: 'Solarman (Deye) connection verified' };
    } catch (err) {
      const msg = err instanceof AxiosError
        ? `HTTP ${err.response?.status}: ${JSON.stringify(err.response?.data)}`
        : String(err);
      return { success: false, message: `Solarman connection failed: ${msg}` };
    }
  }
}
