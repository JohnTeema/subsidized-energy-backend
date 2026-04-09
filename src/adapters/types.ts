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
