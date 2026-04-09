import type { InverterAdapter, InverterBrand } from './types';
import { MockAdapter } from './mock';
import { SolarEdgeAdapter } from './solaredge';
import { GrowattAdapter } from './growatt';
import { SolarmanAdapter } from './solarman';
import { HuaweiAdapter } from './huawei';

const registry: Record<InverterBrand, InverterAdapter> = {
  mock: new MockAdapter(),
  solaredge: new SolarEdgeAdapter(),
  growatt: new GrowattAdapter(),
  deye: new SolarmanAdapter(),
  huawei: new HuaweiAdapter(),
};

export function getAdapter(brand: string): InverterAdapter {
  const adapter = registry[brand as InverterBrand];
  if (!adapter) {
    throw new Error(`Unknown inverter brand: "${brand}". Supported brands: ${Object.keys(registry).join(', ')}`);
  }
  return adapter;
}

export const SUPPORTED_BRANDS = Object.keys(registry) as InverterBrand[];

/** Required credential fields per brand, for frontend validation and help text */
export const BRAND_CREDENTIAL_FIELDS: Record<
  InverterBrand,
  Array<{ field: string; label: string; type: 'text' | 'password'; help?: string }>
> = {
  solaredge: [
    { field: 'siteId', label: 'Site ID', type: 'text', help: 'Find in monitoring.solaredge.com > Admin > API Access' },
    { field: 'apiKey', label: 'API Key', type: 'password', help: 'Find in monitoring.solaredge.com > Admin > API Access' },
  ],
  growatt: [
    { field: 'username', label: 'Username', type: 'text', help: 'Same credentials you use for ShinePhone app' },
    { field: 'password', label: 'Password', type: 'password', help: 'Same credentials you use for ShinePhone app' },
  ],
  deye: [
    { field: 'appId', label: 'App ID', type: 'text', help: 'Request API access from service@solarmanpv.com' },
    { field: 'appSecret', label: 'App Secret', type: 'password', help: 'Request API access from service@solarmanpv.com' },
    { field: 'email', label: 'Email', type: 'text', help: 'Your Solarman account email' },
    { field: 'password', label: 'Password', type: 'password', help: 'Your Solarman account password' },
  ],
  huawei: [
    { field: 'username', label: 'Username', type: 'text', help: 'Find in FusionSolar portal > System Code' },
    { field: 'systemCode', label: 'System Code', type: 'password', help: 'Find in FusionSolar portal > System Code' },
  ],
  mock: [],
};

export type { InverterAdapter, InverterBrand, InverterReading, SiteDetails, ConnectionTestResult } from './types';
