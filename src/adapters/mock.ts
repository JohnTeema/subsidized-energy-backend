import crypto from 'crypto';
import { generateReading } from '../services/mockSimulator';
import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

export class MockAdapter implements InverterAdapter {
  async fetchEnergy(
    _credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading> {
    const reading = generateReading(inverterId, intervalEnd);
    const rawHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(reading.rawData))
      .digest('hex');

    return {
      producer_id: producerId,
      inverter_id: inverterId,
      brand: 'mock',
      kwh_produced: reading.kwhProduced,
      interval_start: intervalStart.toISOString(),
      interval_end: intervalEnd.toISOString(),
      rated_capacity_kw: 5.0,
      latitude: 0,
      longitude: 0,
      raw_hash: rawHash,
      panel_power: reading.rawData.powerW as number,
      battery_capacity: 90,
      battery_voltage: 48,
      epv_total: 1000,
      epv_today: reading.kwhProduced,
      device_serial: 'MOCK-001',
      plant_name: 'Mock Plant',
      location: 'Simulated Location',
    };
  }

  async fetchSiteDetails(_credentials: Record<string, string>): Promise<SiteDetails> {
    return { rated_capacity_kw: 5.0, latitude: 0, longitude: 0 };
  }

  async testConnection(_credentials: Record<string, string>): Promise<ConnectionTestResult> {
    return { success: true, message: 'Mock adapter always succeeds' };
  }
}
