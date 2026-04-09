import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Growatt = require('growatt') as new (options?: Record<string, unknown>) => GrowattInstance;

import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

// Minimal types for the growatt package
interface GrowattPlant {
  plantId: string | number;
  plantName?: string;
  totalPower?: number;
  peakPower?: number;
  lat?: number;
  lng?: number;
}

interface GrowattDevice {
  sn: string;
  deviceType?: number;
  eToday?: number;
  eTotal?: number;
}

interface GrowattHistoryEntry {
  time: string;
  pvPower?: number;
  eAcToday?: number;
  [key: string]: unknown;
}

interface GrowattInstance {
  login(username: string, password: string): Promise<{ userId?: string; errCode?: number; errMsg?: string }>;
  logout(userId: string): Promise<void>;
  getAllPlantData(options?: Record<string, unknown>): Promise<Record<string, GrowattPlant & { devices?: GrowattDevice[] }>>;
  getDevicesByPlant(plantId: string | number): Promise<{ datas?: GrowattDevice[] }>;
  getHistory(
    type: number,
    sn: string,
    startDate: Date,
    endDate: Date,
    start: number,
    allDatasets: boolean,
  ): Promise<{ datas?: GrowattHistoryEntry[] }>;
}

// Rate limit: 50 requests/hour per account
const hourlyCallCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_HOURLY_CALLS = 50;

function checkRateLimit(username: string): void {
  const now = Date.now();
  const entry = hourlyCallCounts.get(username);
  const nextHour = now + 3_600_000 - (now % 3_600_000);

  if (!entry || now >= entry.resetAt) {
    hourlyCallCounts.set(username, { count: 1, resetAt: nextHour });
    return;
  }
  if (entry.count >= MAX_HOURLY_CALLS) {
    throw new Error(`Growatt rate limit reached (${MAX_HOURLY_CALLS}/hour). Try again later.`);
  }
  entry.count++;
}

function incrementCallCount(username: string, n: number): void {
  const now = Date.now();
  const entry = hourlyCallCounts.get(username);
  if (!entry || now >= entry.resetAt) return;
  entry.count += n;
}

export class GrowattAdapter implements InverterAdapter {
  async fetchEnergy(
    credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading> {
    const { username, password } = credentials;
    if (!username || !password) throw new Error('Growatt requires username and password');

    checkRateLimit(username);

    const growatt = new Growatt({ indexCate: '1' });
    const loginResult = await growatt.login(username, password);
    incrementCallCount(username, 1);

    if (loginResult.errCode && loginResult.errCode !== 0) {
      throw new Error(`Growatt login failed: ${loginResult.errMsg ?? loginResult.errCode}`);
    }
    const userId = loginResult.userId ?? '';

    let kwhProduced = 0;
    let peakPower = 5.0;
    let lat = 0;
    let lng = 0;
    let rawData: Record<string, unknown> = {};

    try {
      // Get all plant data
      const plants = await growatt.getAllPlantData({ plantData: true, deviceData: false, weather: false });
      incrementCallCount(username, 1);
      const plantEntries = Object.values(plants);

      if (plantEntries.length > 0) {
        const plant = plantEntries[0];
        peakPower = plant.peakPower ?? 5.0;
        lat = plant.lat ?? 0;
        lng = plant.lng ?? 0;

        // Get devices for the first plant
        const devicesRes = await growatt.getDevicesByPlant(plant.plantId);
        incrementCallCount(username, 1);
        const devices = devicesRes?.datas ?? [];

        if (devices.length > 0) {
          const device = devices[0];
          // Type 1 = inverter (MIX, SPH, etc.)
          const history = await growatt.getHistory(1, device.sn, intervalStart, intervalEnd, 0, true);
          incrementCallCount(username, 1);
          const entries = history?.datas ?? [];
          rawData = { plant, device, historyCount: entries.length };

          // Sum power readings over interval → approximate kWh
          // eAcToday is cumulative daily kWh; take the last value's increment
          if (entries.length > 0) {
            const first = entries[0];
            const last = entries[entries.length - 1];
            const firstKwh = parseFloat(String(first.eAcToday ?? 0));
            const lastKwh = parseFloat(String(last.eAcToday ?? 0));
            kwhProduced = Math.max(0, lastKwh - firstKwh);
          }
        }
      }
    } finally {
      try { await growatt.logout(userId); } catch { /* ignore */ }
    }

    const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');

    return {
      producer_id: producerId,
      inverter_id: inverterId,
      brand: 'growatt',
      kwh_produced: parseFloat(kwhProduced.toFixed(4)),
      interval_start: intervalStart.toISOString(),
      interval_end: intervalEnd.toISOString(),
      rated_capacity_kw: peakPower,
      latitude: lat,
      longitude: lng,
      raw_hash: rawHash,
    };
  }

  async fetchSiteDetails(credentials: Record<string, string>): Promise<SiteDetails> {
    const { username, password } = credentials;
    if (!username || !password) throw new Error('Growatt requires username and password');

    checkRateLimit(username);
    const growatt = new Growatt({ indexCate: '1' });
    const loginResult = await growatt.login(username, password);
    incrementCallCount(username, 1);

    const userId = loginResult.userId ?? '';
    try {
      const plants = await growatt.getAllPlantData({ plantData: true, deviceData: false, weather: false });
      incrementCallCount(username, 1);
      const plant = Object.values(plants)[0];
      return {
        rated_capacity_kw: plant?.peakPower ?? 5.0,
        latitude: plant?.lat ?? 0,
        longitude: plant?.lng ?? 0,
      };
    } finally {
      try { await growatt.logout(userId); } catch { /* ignore */ }
    }
  }

  async testConnection(credentials: Record<string, string>): Promise<ConnectionTestResult> {
    const { username, password } = credentials;
    if (!username) return { success: false, message: 'username is required' };
    if (!password) return { success: false, message: 'password is required' };

    try {
      checkRateLimit(username);
      const growatt = new Growatt({ indexCate: '1' });
      const loginResult = await growatt.login(username, password);
      incrementCallCount(username, 1);

      if (loginResult.errCode && loginResult.errCode !== 0) {
        return { success: false, message: `Login failed: ${loginResult.errMsg ?? loginResult.errCode}` };
      }
      try { await growatt.logout(loginResult.userId ?? ''); } catch { /* ignore */ }
      return { success: true, message: 'Growatt connection verified' };
    } catch (err) {
      return { success: false, message: `Growatt connection failed: ${String(err)}` };
    }
  }
}
