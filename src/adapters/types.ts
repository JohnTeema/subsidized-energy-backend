/**
 * Shared adapter interface and normalized energy reading schema.
 * All inverter brand adapters output InverterReading.
 */

export type InverterBrand = 'growatt' | 'deye' | 'solaredge' | 'huawei' | 'mock';

export interface InverterReading {
  producer_id: string;
  inverter_id: string;
  brand: InverterBrand;
  kwh_produced: number;
  interval_start: string; // ISO DateTime
  interval_end: string;   // ISO DateTime
  rated_capacity_kw: number;
  latitude: number;
  longitude: number;
  raw_hash: string;
  // Extended telemetry — populated by adapters that support it
  panel_power?: number;
  battery_capacity?: number;
  battery_voltage?: number;
  epv_total?: number;
  epv_today?: number;
  device_serial?: string;
  plant_name?: string;
  location?: string;
}

export interface SiteDetails {
  rated_capacity_kw: number;
  latitude: number;
  longitude: number;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}

export interface InverterAdapter {
  fetchEnergy(
    credentials: Record<string, string>,
    inverterId: string,
    producerId: string,
    intervalStart: Date,
    intervalEnd: Date,
  ): Promise<InverterReading>;

  fetchSiteDetails(credentials: Record<string, string>): Promise<SiteDetails>;

  testConnection(credentials: Record<string, string>): Promise<ConnectionTestResult>;
}
