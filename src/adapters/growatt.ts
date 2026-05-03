import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Growatt = require('growatt') as new (options?: Record<string, unknown>) => GrowattInstance;

import type { InverterAdapter, InverterReading, SiteDetails, ConnectionTestResult } from './types';

// Minimal types for the growatt package
interface GrowattPlant {
id: string | number;
plantId?: string | number;
plantName?: string;
totalPower?: number;
peakPower?: number;
lat?: number;
lng?: number;
}

interface GrowattDevice {
sn: string;
deviceType?: number;
growattType?: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
totalData?: Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
statusData?: Record<string, any>;
}

interface GrowattInstance {
login(username: string, password: string): Promise<{ userId?: string; errCode?: number; errMsg?: string }>;
logout(userId: string): Promise<void>;
getAllPlantData(options?: Record<string, unknown>): Promise<Record<string, GrowattPlant & { devices?: Record<string, GrowattDevice> }>>;
getDevicesByPlant(plantId: string | number): Promise<{ datas?: GrowattDevice[] }>;
}

interface AxiosError {
response?: { status?: number; data?: unknown };
config?: { url?: string; method?: string; data?: string; params?: unknown };
message?: string;
}

function maskPassword(data: string | undefined): string {
if (!data) return '(empty)';
try {
const parsed = new URLSearchParams(data);
const out: Record<string, string> = {};
for (const [k, v] of parsed.entries()) {
out[k] = (k === 'password' || k === 'passwordCrc') ? `${v.slice(0, 4)}****` : v;
}
return JSON.stringify(out);
} catch {
return data.slice(0, 40) + '…';
}
}

function addGrowattInterceptors(growatt: GrowattInstance): void {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ax = (growatt as any).axios;
if (!ax) return;

ax.interceptors.request.use((config: { url?: string; method?: string; data?: string; params?: unknown }) => {
console.log('[Growatt] →', config.method?.toUpperCase(), config.url, '| body:', maskPassword(config.data), '| params:', JSON.stringify(config.params ?? {}));
return config;
});

ax.interceptors.response.use(
(res: { status: number; config: { url?: string } }) => {
console.log('[Growatt] ←', res.status, res.config?.url);
return res;
},
(err: AxiosError) => {
console.error('[Growatt] ✗', err.config?.method?.toUpperCase(), err.config?.url,
'| status:', err.response?.status,
'| body:', JSON.stringify(err.response?.data ?? null),
'| msg:', err.message);
return Promise.reject(err);
},
);
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

console.log(`[Growatt] fetchEnergy: user=${username} pass=${password.slice(0, 3)}*** inverterId=${inverterId}`);

const growatt = new Growatt({ indexCate: '1' });
addGrowattInterceptors(growatt);

let loginResult: { userId?: string; errCode?: number; errMsg?: string };
try {
loginResult = await growatt.login(username, password);
} catch (err) {
const e = err as AxiosError;
console.error('[Growatt] login threw:', e.message, '| status:', e.response?.status, '| body:', JSON.stringify(e.response?.data ?? null));
throw err;
}
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
	let plants: Record<string, GrowattPlant & { devices?: Record<string, GrowattDevice> }>;
	try {
		plants = await growatt.getAllPlantData({ plantData: true, deviceData: false, weather: false });
	} catch (err) {
		const e = err as AxiosError;
		console.error('[Growatt] getAllPlantData threw:', e.message, '| status:', e.response?.status, '| body:', JSON.stringify(e.response?.data ?? null));
		throw err;
	}
	incrementCallCount(username, 1);
	console.log('[Growatt] raw plants response (truncated):', JSON.stringify(plants).substring(0, 2000));

	const plantIds = Object.keys(plants);
	console.log('[Growatt] plants found:', plantIds.length, plantIds.map(id => ({ id: plants[id].id, name: plants[id].plantName })));

	if (plantIds.length === 0) {
		throw new Error('No plants found in Growatt account');
	}

	const plant = plants[plantIds[0]];
	peakPower = plant.peakPower ?? 5.0;
	lat = plant.lat ?? 0;
	lng = plant.lng ?? 0;

	const devices = plant.devices;
	if (!devices || Object.keys(devices).length === 0) {
		throw new Error('No devices found for plant');
	}

	const deviceSn = Object.keys(devices)[0];
	const deviceData = devices[deviceSn];
	const totalData = deviceData.totalData ?? {};
	const statusData = deviceData.statusData ?? {};

	// epvToday is the actual solar PV production today — API returns it as a string
	kwhProduced = parseFloat(String(totalData.epvToday ?? 0)) || 0;

	// If epvToday is 0 or negligible, check panelPower — if panels are actively producing,
	// estimate kWh from instantaneous watts × interval duration
	if (kwhProduced < 0.001) {
		const panelPowerW = parseFloat(String(statusData.panelPower ?? 0)) || 0;
		if (panelPowerW > 0) {
			const intervalHours = (intervalEnd.getTime() - intervalStart.getTime()) / 3_600_000;
			kwhProduced = (panelPowerW / 1000) * intervalHours;
			console.log(`[Growatt] epvToday=0 but panelPower=${panelPowerW}W active — estimated ${kwhProduced.toFixed(4)} kWh from power × interval`);
		}
	}

	rawData = {
		plant: { id: plant.id, name: plant.plantName, peakPower },
		device: { sn: deviceSn, growattType: deviceData.growattType },
		epvToday: parseFloat(String(totalData.epvToday ?? 0)) || 0,
		epvTotal: parseFloat(String(totalData.epvTotal ?? 0)) || 0,
		panelPower: parseFloat(String(statusData.panelPower ?? 0)) || 0,
		loadPower: parseFloat(String(statusData.loadPower ?? 0)) || 0,
		batteryCapacity: parseFloat(String(statusData.batteryCapacity ?? statusData.capacity ?? 0)) || 0,
		vBat: parseFloat(String(statusData.vBat ?? 0)) || 0,
	};

	console.log(`[Growatt] kWh produced: ${kwhProduced} (epvToday=${totalData.epvToday}, panelPower=${statusData.panelPower}W, epvTotal=${totalData.epvTotal})`);
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
console.log(`[Growatt] fetchSiteDetails: user=${username} pass=${password.slice(0, 3)}***`);
const growatt = new Growatt({ indexCate: '1' });
addGrowattInterceptors(growatt);

let loginResult: { userId?: string; errCode?: number; errMsg?: string };
try {
loginResult = await growatt.login(username, password);
} catch (err) {
const e = err as AxiosError;
console.error('[Growatt] login threw:', e.message, '| status:', e.response?.status, '| body:', JSON.stringify(e.response?.data ?? null));
throw err;
}
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
} catch (err) {
const e = err as AxiosError;
console.error('[Growatt] fetchSiteDetails data call threw:', e.message, '| status:', e.response?.status, '| body:', JSON.stringify(e.response?.data ?? null));
throw err;
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
console.log(`[Growatt] testConnection: user=${username} pass=${password.slice(0, 3)}***`);
const growatt = new Growatt({ indexCate: '1' });
addGrowattInterceptors(growatt);
const loginResult = await growatt.login(username, password);
incrementCallCount(username, 1);

if (loginResult.errCode && loginResult.errCode !== 0) {
return { success: false, message: `Login failed: ${loginResult.errMsg ?? loginResult.errCode}` };
}
try { await growatt.logout(loginResult.userId ?? ''); } catch { /* ignore */ }
return { success: true, message: 'Growatt connection verified' };
} catch (err) {
const e = err as AxiosError;
console.error('[Growatt] testConnection threw:', e.message, '| status:', e.response?.status, '| body:', JSON.stringify(e.response?.data ?? null));
return { success: false, message: `Growatt connection failed: ${String(err)}` };
}
}
}