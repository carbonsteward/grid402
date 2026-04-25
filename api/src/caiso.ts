// CAISO fetchers — price (OASIS) and generation mix (fuelsource.csv).
//
// Two independent upstream endpoints (both public domain, no auth):
//
//   Price (5-min LMP by node):
//     https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP&...
//     Returns a ZIP containing one CSV.
//
//   Generation mix (5-min MW by fuel, system-wide):
//     https://www.caiso.com/outlook/current/fuelsource.csv
//     Returns plain CSV, ~18 hours of 5-min rows.
//
// Both are parsed to normalized shapes. Short TTL caches avoid hammering
// upstream on bursty agent traffic.

import { unzipSync, strFromU8 } from "fflate";
import type { FuelType } from "./types.js";

// ============================================================================
// PRICE (OASIS)
// ============================================================================

export interface CaisoPriceTick {
  iso: "CAISO";
  zone: string;                 // e.g. "TH_NP15_GEN-APND"
  intervalStartUtc: string;     // ISO-8601
  intervalEndUtc: string;
  lmpUsdPerMwh: number;
  market: "RTM" | "DAM";
  ts: string;                   // fetched-at
}

// Format a Date into CAISO's expected UTC string: YYYYMMDDTHH:mm-0000
function toCaisoUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}-0000`
  );
}

export async function fetchCaisoLiveLmp(
  zone: string = "TH_NP15_GEN-APND",
): Promise<CaisoPriceTick> {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);

  const params = new URLSearchParams({
    queryname: "PRC_INTVL_LMP",
    startdatetime: toCaisoUtc(start),
    enddatetime: toCaisoUtc(now),
    market_run_id: "RTM",
    version: "3",
    node: zone,
    resultformat: "6",
  });

  const url = `https://oasis.caiso.com/oasisapi/SingleZip?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CAISO OASIS returned ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const entry = Object.entries(files).find(([name]) => name.endsWith(".csv"));
  if (!entry) throw new Error("CAISO response contained no CSV");
  const csv = strFromU8(entry[1]);

  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error("CAISO response had no data rows");
  const header = rows[0]!.split(",").map(s => s.trim());
  const idx = {
    start: header.indexOf("INTERVALSTARTTIME_GMT"),
    end: header.indexOf("INTERVALENDTIME_GMT"),
    value: header.indexOf("VALUE"),
    dataItem: header.indexOf("DATA_ITEM"),
  };

  const lmpRows = rows
    .slice(1)
    .map(r => r.split(","))
    .filter(cols => cols[idx.dataItem] === "LMP_PRC");

  if (lmpRows.length === 0) throw new Error("CAISO returned no LMP_PRC rows");

  const latest = lmpRows.sort((a, b) =>
    (b[idx.start] ?? "").localeCompare(a[idx.start] ?? ""),
  )[0]!;

  return {
    iso: "CAISO",
    zone,
    intervalStartUtc: latest[idx.start] ?? "",
    intervalEndUtc:   latest[idx.end]   ?? "",
    lmpUsdPerMwh:     parseFloat(latest[idx.value] ?? "0"),
    market: "RTM",
    ts: new Date().toISOString(),
  };
}

const priceCache = new Map<string, { at: number; tick: CaisoPriceTick }>();
export async function getCaisoLivePriceCached(
  zone: string,
): Promise<CaisoPriceTick> {
  const hit = priceCache.get(zone);
  if (hit && Date.now() - hit.at < 60_000) return hit.tick;
  const tick = await fetchCaisoLiveLmp(zone);
  priceCache.set(zone, { at: Date.now(), tick });
  return tick;
}

// ============================================================================
// GENERATION MIX (fuelsource.csv)
// ============================================================================

const FUELSOURCE_URL = "https://www.caiso.com/outlook/current/fuelsource.csv";

/**
 * Canonical mapping from CAISO fuelsource.csv column names to Grid402's
 * unified FuelType taxonomy. Hydro rolls large+small into one bucket.
 * "Batteries" maps to `storage` (positive = discharge, negative = charge).
 */
const CAISO_FUEL_MAP: Record<string, FuelType> = {
  Solar:          "solar",
  Wind:           "wind",
  Geothermal:     "geothermal",
  Biomass:        "biomass",
  Biogas:         "biomass",       // rolled into biomass
  "Small hydro":  "hydro",
  "Large Hydro":  "hydro",
  Coal:           "coal",
  Nuclear:        "nuclear",
  "Natural Gas":  "gas",
  Batteries:      "storage",
  Imports:        "imports",
  Other:          "other",
};

export interface CaisoMixTick {
  iso: "CAISO";
  zone: "CAISO";               // mix is system-wide, not node-level
  intervalStartUtc: string;
  intervalEndUtc: string;
  mw: Partial<Record<FuelType, number>>;
  totalMw: number;             // sum of generation (excludes imports & storage charge)
  ts: string;
}

/**
 * Fetch and parse the system-wide CAISO fuel source CSV. Returns the latest
 * 5-min interval with MW values keyed by canonical fuel type.
 */
export async function fetchCaisoGenerationMix(): Promise<CaisoMixTick> {
  const res = await fetch(FUELSOURCE_URL);
  if (!res.ok) throw new Error(`CAISO fuelsource returned ${res.status}`);
  const csv = await res.text();

  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error("CAISO fuelsource had no data rows");
  const header = rows[0]!.split(",").map(s => s.trim());

  // Find the last row whose Time is not all-zeroes / malformed.
  const dataRows = rows.slice(1)
    .map(r => r.split(","))
    .filter(cols => cols.length === header.length && /^\d{2}:\d{2}$/.test(cols[0] ?? ""));

  if (dataRows.length === 0) throw new Error("CAISO fuelsource had no valid rows");
  const latest = dataRows[dataRows.length - 1]!;

  // Build an MW map by folding CSV columns into canonical fuel types.
  const mw: Partial<Record<FuelType, number>> = {};
  for (let i = 1; i < header.length; i++) {
    const col = header[i]!;
    const canonical = CAISO_FUEL_MAP[col];
    if (!canonical) continue;
    const raw = parseFloat(latest[i] ?? "0");
    if (!isFinite(raw)) continue;
    mw[canonical] = (mw[canonical] ?? 0) + raw;
  }

  // Build the interval UTC range from the "HH:MM" field.
  // CAISO fuelsource is stamped in Pacific time; we convert to today's UTC.
  const [hh, mm] = (latest[0] as string).split(":").map(n => parseInt(n, 10));
  const now = new Date();
  // Compose a Pacific-time wall clock for today, then shift to UTC via Intl.
  const pacificToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const offsetHours = isPacificDst(pacificToday) ? 7 : 8;
  const intervalStart = new Date(
    Date.UTC(
      pacificToday.getUTCFullYear(),
      pacificToday.getUTCMonth(),
      pacificToday.getUTCDate(),
      (hh ?? 0) + offsetHours,
      mm ?? 0,
      0,
    ),
  );
  const intervalEnd = new Date(intervalStart.getTime() + 5 * 60 * 1000);

  // Total generation = sum of positive MW, excluding imports + storage.
  let totalMw = 0;
  for (const [fuel, value] of Object.entries(mw)) {
    if (fuel === "imports" || fuel === "storage") continue;
    if (value && value > 0) totalMw += value;
  }

  return {
    iso: "CAISO",
    zone: "CAISO",
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc:   intervalEnd.toISOString(),
    mw,
    totalMw: Math.round(totalMw),
    ts: new Date().toISOString(),
  };
}

// Approximate Pacific DST detection: PDT runs ~2nd Sunday March → 1st Sunday November.
// Cloudflare Workers lack tzdb; this rule covers 99% of the year correctly.
function isPacificDst(d: Date): boolean {
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

let mixCache: { at: number; tick: CaisoMixTick } | null = null;
export async function getCaisoMixCached(): Promise<CaisoMixTick> {
  if (mixCache && Date.now() - mixCache.at < 60_000) return mixCache.tick;
  const tick = await fetchCaisoGenerationMix();
  mixCache = { at: Date.now(), tick };
  return tick;
}
