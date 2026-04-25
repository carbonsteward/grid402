// ERCOT fetchers — price (15-min RTM SPP) and generation mix (5-min, 8 fuels).
//
// Two independent upstream endpoints, both pure JSON via the Electricity Maps
// public Cloud Run proxy. Direct calls to www.ercot.com return HTTP 403 due to
// Imperva/Incapsula bot protection — proxy is mandatory.
//
//   Price (15-min RTM Settlement Point Prices, hubs + load zones):
//     <PROXY>/api/1/services/read/dashboards/systemWidePrices.json?host=https://www.ercot.com
//
//   Generation mix (5-min MW by fuel, system-wide, 8 fuels):
//     <PROXY>/api/1/services/read/dashboards/fuel-mix.json?host=https://www.ercot.com
//
// TODO: replace with self-hosted proxy in production. EM proxy works for
// hackathon demo. License: ERCOT public dashboards are US public domain.
//
// Both responses include explicit timezone offsets (CDT=-0500, CST=-0600) so
// timestamps can be parsed directly. We additionally implement Central DST
// detection for any place we need to synthesize a UTC interval boundary.

import type { FuelType } from "./types.js";

// ============================================================================
// CONFIG
// ============================================================================

// EM proxy default. Self-host in production via Cloudflare Workers / Cloud Run.
const ERCOT_PROXY_URL =
  process.env.ERCOT_PROXY_URL ?? "https://us-ca-proxy-jfnx5klx2a-uw.a.run.app";

const ERCOT_HOST_QS = "host=https://www.ercot.com";

// Some proxies/upstreams care about UA — set a stable Grid402 identifier.
const ERCOT_FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Grid402/0.1 (https://github.com/carbonsteward/grid402)",
};

// ============================================================================
// PRICE (systemWidePrices.json)
// ============================================================================

export interface ErcotPriceTick {
  iso: "ERCOT";
  zone: string;                 // e.g. "HB_NORTH"
  intervalStartUtc: string;     // ISO-8601
  intervalEndUtc: string;       // ISO-8601
  lmpUsdPerMwh: number;
  market: "RTM";
  ts: string;                   // fetched-at
}

// Canonical Grid402 hub/zone code -> ERCOT JSON field name.
// Hubs: HB_*  ·  Load zones: LZ_*  ·  HB_HUBAVG = average of 4 trading hubs.
const ERCOT_HUB_FIELD_MAP: Record<string, string> = {
  HB_NORTH:   "hbNorth",
  HB_HOUSTON: "hbHouston",
  HB_SOUTH:   "hbSouth",
  HB_WEST:    "hbWest",
  HB_PAN:     "hbPan",
  HB_BUSAVG:  "hbBusAvg",
  HB_HUBAVG:  "hbHubAvg",
  LZ_NORTH:   "lzNorth",
  LZ_HOUSTON: "lzHouston",
  LZ_SOUTH:   "lzSouth",
  LZ_WEST:    "lzWest",
  LZ_AEN:     "lzAen",
  LZ_CPS:     "lzCps",
  LZ_LCRA:    "lzLcra",
  LZ_RAYBN:   "lzRaybn",
};

interface ErcotPriceRow {
  intervalEnding?: string;     // "HH:MM" wall-clock, Central time
  dstFlag?: string;            // "Y" | "N"
  timestamp?: string;          // "2026-04-24 22:15:00-0500"
  interval?: number;           // epoch ms (interval-end)
  [hubField: string]: number | string | undefined;
}

interface ErcotPriceJson {
  lastUpdated?: string;
  rtSppData?: ErcotPriceRow[];
}

/**
 * Fetch the latest 15-minute Real-Time Settlement Point Price for a hub.
 *
 * @param hub canonical Grid402 hub or load-zone code (e.g. "HB_NORTH").
 *   Defaults to "HB_HUBAVG" — the system-wide hub average.
 */
export async function fetchErcotPrice(
  hub: string = "HB_HUBAVG",
): Promise<ErcotPriceTick> {
  const fieldName = ERCOT_HUB_FIELD_MAP[hub.toUpperCase()];
  if (!fieldName) {
    throw new Error(
      `Unknown ERCOT hub/zone "${hub}". Known: ${Object.keys(ERCOT_HUB_FIELD_MAP).join(", ")}`,
    );
  }

  const url =
    `${ERCOT_PROXY_URL}/api/1/services/read/dashboards/systemWidePrices.json?${ERCOT_HOST_QS}`;
  const res = await fetch(url, { headers: ERCOT_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ERCOT systemWidePrices returned ${res.status}`);

  const json = (await res.json()) as ErcotPriceJson;
  const rows = json.rtSppData;
  if (!rows || rows.length === 0) {
    throw new Error("ERCOT systemWidePrices had no rtSppData rows");
  }

  // Pick the row with the largest `interval` (epoch ms, interval-end).
  let latest: ErcotPriceRow | undefined;
  let latestInterval = -Infinity;
  for (const row of rows) {
    const iv = typeof row.interval === "number" ? row.interval : NaN;
    if (Number.isFinite(iv) && iv > latestInterval) {
      latestInterval = iv;
      latest = row;
    }
  }
  if (!latest) throw new Error("ERCOT systemWidePrices had no parseable rows");

  const rawValue = latest[fieldName];
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    throw new Error(
      `ERCOT systemWidePrices missing numeric ${fieldName} for latest interval`,
    );
  }

  // `timestamp` is interval-end in Central time with explicit offset.
  // Date.parse handles "2026-04-24 22:15:00-0500" natively (RFC2822-ish).
  const tsStr = typeof latest.timestamp === "string" ? latest.timestamp : "";
  const intervalEndMs = Date.parse(tsStr.replace(" ", "T")) || latestInterval;
  if (!Number.isFinite(intervalEndMs)) {
    throw new Error(`ERCOT systemWidePrices: cannot parse timestamp "${tsStr}"`);
  }
  const intervalEnd = new Date(intervalEndMs);
  const intervalStart = new Date(intervalEndMs - 15 * 60 * 1000);

  return {
    iso: "ERCOT",
    zone: hub.toUpperCase(),
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc:   intervalEnd.toISOString(),
    lmpUsdPerMwh:     rawValue,
    market: "RTM",
    ts: new Date().toISOString(),
  };
}

const priceCache = new Map<string, { at: number; tick: ErcotPriceTick }>();
export async function getErcotPriceCached(
  hub: string = "HB_HUBAVG",
): Promise<ErcotPriceTick> {
  const key = hub.toUpperCase();
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.tick;
  const tick = await fetchErcotPrice(key);
  priceCache.set(key, { at: Date.now(), tick });
  return tick;
}

// ============================================================================
// GENERATION MIX (fuel-mix.json)
// ============================================================================

/**
 * Canonical mapping from ERCOT fuel-mix.json column names to Grid402's
 * unified FuelType taxonomy. ERCOT exposes 8 fuels system-wide; biomass/diesel/
 * petcoke are bundled in "Other".
 *
 *   Power Storage: positive = discharge, negative = charge (sign preserved).
 */
const ERCOT_FUEL_MAP: Record<string, FuelType> = {
  "Coal and Lignite": "coal",
  "Natural Gas":      "gas",
  Nuclear:            "nuclear",
  Hydro:              "hydro",
  Solar:              "solar",
  Wind:               "wind",
  "Power Storage":    "storage",
  Other:              "other",
};

export interface ErcotMixTick {
  iso: "ERCOT";
  zone: "ERCOT";                // mix is system-wide, not node-level
  intervalStartUtc: string;
  intervalEndUtc: string;
  mw: Partial<Record<FuelType, number>>;
  totalMw: number;              // sum of generation (excludes storage)
  ts: string;
}

interface ErcotFuelGen {
  gen?: number;
}

interface ErcotMixJson {
  lastUpdated?: string;
  monthlyCapacity?: Record<string, number>;
  types?: string[];
  // data: { "YYYY-MM-DD": { "YYYY-MM-DD HH:MM:SS-0500": { Fuel: {gen} } } }
  data?: Record<string, Record<string, Record<string, ErcotFuelGen>>>;
}

/**
 * Fetch the latest 5-minute system-wide generation mix.
 */
export async function fetchErcotMix5Min(): Promise<ErcotMixTick> {
  const url =
    `${ERCOT_PROXY_URL}/api/1/services/read/dashboards/fuel-mix.json?${ERCOT_HOST_QS}`;
  const res = await fetch(url, { headers: ERCOT_FETCH_HEADERS });
  if (!res.ok) throw new Error(`ERCOT fuel-mix returned ${res.status}`);

  const json = (await res.json()) as ErcotMixJson;
  const data = json.data;
  if (!data || typeof data !== "object") {
    throw new Error("ERCOT fuel-mix had no `data` object");
  }

  // Pick the latest day key, then the latest interval-end key inside it.
  // Keys are lexicographically sortable as ISO date / Central-local strings.
  const dayKeys = Object.keys(data).sort();
  const latestDay = dayKeys[dayKeys.length - 1];
  if (!latestDay) throw new Error("ERCOT fuel-mix had empty `data`");
  const dayBlock = data[latestDay];
  if (!dayBlock || typeof dayBlock !== "object") {
    throw new Error("ERCOT fuel-mix latest-day block is empty");
  }
  const intervalKeys = Object.keys(dayBlock).sort();
  const latestKey = intervalKeys[intervalKeys.length - 1];
  if (!latestKey) throw new Error("ERCOT fuel-mix latest day has no intervals");
  const fuels = dayBlock[latestKey];
  if (!fuels) throw new Error("ERCOT fuel-mix latest interval is empty");

  // Build canonical MW map.
  const mw: Partial<Record<FuelType, number>> = {};
  for (const [rawCol, payload] of Object.entries(fuels)) {
    const canonical = ERCOT_FUEL_MAP[rawCol];
    if (!canonical) continue;
    const value = typeof payload?.gen === "number" ? payload.gen : NaN;
    if (!Number.isFinite(value)) continue;
    // Solar can briefly read negative at night (self-consumption) — clamp like CAISO.
    const clamped = canonical === "solar" ? Math.max(value, 0) : value;
    mw[canonical] = (mw[canonical] ?? 0) + clamped;
  }

  // Total generation = sum of positive MW, excluding storage (which is signed).
  let totalMw = 0;
  for (const [fuel, value] of Object.entries(mw)) {
    if (fuel === "storage") continue;
    if (typeof value === "number" && value > 0) totalMw += value;
  }

  // Resolve interval-end UTC.
  // The latestKey looks like "2026-04-24 22:19:57-0500" — Date.parse handles
  // it once we replace the space with 'T'. Fall back to local-Central + DST
  // synthesis if the offset is missing.
  const tEndMs = parseErcotTimestamp(latestKey);
  const intervalEnd = new Date(tEndMs);
  const intervalStart = new Date(tEndMs - 5 * 60 * 1000);

  return {
    iso: "ERCOT",
    zone: "ERCOT",
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc:   intervalEnd.toISOString(),
    mw,
    totalMw: Math.round(totalMw),
    ts: new Date().toISOString(),
  };
}

let mixCache: { at: number; tick: ErcotMixTick } | null = null;
export async function getErcotMixCached(): Promise<ErcotMixTick> {
  if (mixCache && Date.now() - mixCache.at < 60_000) return mixCache.tick;
  const tick = await fetchErcotMix5Min();
  mixCache = { at: Date.now(), tick };
  return tick;
}

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================

/**
 * Parse an ERCOT-style timestamp into epoch ms (UTC).
 *
 * Accepts:
 *   "2026-04-24 22:19:57-0500"  (preferred — explicit offset)
 *   "2026-04-24 22:19:57"        (naive — assumed Central, DST inferred)
 */
export function parseErcotTimestamp(s: string): number {
  if (!s) throw new Error("parseErcotTimestamp: empty input");

  // Replace the single space between date and time with 'T' so Date.parse
  // treats it as ISO-8601-ish.
  const withT = s.replace(" ", "T");
  const ms = Date.parse(withT);
  if (Number.isFinite(ms)) return ms;

  // Fallback: naive parse + Central DST inference.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`parseErcotTimestamp: unrecognized format "${s}"`);
  const [year, mon, day, hh, mm, ss] = m.slice(1).map(n => parseInt(n, 10)) as [
    number, number, number, number, number, number,
  ];
  const naiveUtc = Date.UTC(year, mon - 1, day, hh, mm, ss);
  // Determine if that wall-clock instant is in CDT (-5h) or CST (-6h).
  const offsetHours = isCentralDst(new Date(naiveUtc)) ? 5 : 6;
  return naiveUtc + offsetHours * 60 * 60 * 1000;
}

/**
 * Approximate Central DST detection: CDT runs 2nd Sunday of March → 1st Sunday
 * of November. ERCOT/Texas observes US federal DST. Mirrors caiso.ts's
 * isPacificDst() — runtime has no tzdb on Workers, so we rely on rule-based
 * inference. Covers 99.9% of the year correctly (transition hours can be off).
 */
export function isCentralDst(d: Date): boolean {
  const y = d.getUTCFullYear();
  const dstStart = nthSundayOfMonth(y, 2, 2);  // 2nd Sunday in March
  const dstEnd   = nthSundayOfMonth(y, 10, 1); // 1st Sunday in November
  return d >= dstStart && d < dstEnd;
}

function nthSundayOfMonth(year: number, month: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const firstSunday = (7 - first.getUTCDay()) % 7;
  return new Date(Date.UTC(year, month, 1 + firstSunday + (n - 1) * 7));
}
