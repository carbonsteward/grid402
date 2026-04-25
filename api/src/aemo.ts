// AEMO (Australian Energy Market Operator) — National Electricity Market parser.
//
// DUID->fuel registry frozen on 2026-04-25 from OpenNEM's facility_registry.json
// (https://github.com/opennem/opennem, MIT licensed). See aemo-duid-registry.json
// for the slim subset and attribution.
//
// Two upstream NEMWEB rolling directories (no auth, public):
//
//   Price (5-min regional reference price):
//     https://nemweb.com.au/Reports/Current/DispatchIS_Reports/
//     Lists `PUBLIC_DISPATCHIS_<YYYYMMDDHHMM>_<seq>.zip` — fetch latest by name.
//
//   Generation mix (5-min DUID-level SCADA):
//     https://nemweb.com.au/Reports/Current/Dispatch_SCADA/
//     Lists `PUBLIC_DISPATCHSCADA_<YYYYMMDDHHMM>_<seq>.zip` — fetch latest.
//
// Both files are NEMDF "C/I/D" multi-section CSV (header `C,...`, interface
// definition `I,<package>,<table>,<version>,<col1>,...`, data rows
// `D,<package>,<table>,<version>,<val1>,...`).
//
// Time gotcha: NEM market time is fixed at AEST (UTC+10) ALL YEAR — no DST,
// despite member regions observing AEDT in summer. We subtract 10h from the
// quoted `SETTLEMENTDATE` to get UTC. Do NOT use Australia/Sydney zone.

import { unzipSync, strFromU8 } from "fflate";
import type { FuelType } from "./types.js";
import registryJson from "./aemo-duid-registry.json" with { type: "json" };

// ============================================================================
// REGISTRY LOADING
// ============================================================================

interface DuidEntry {
  f: FuelType;        // canonical fuel
  r: NemRegion;       // home region
  p?: number;         // 1 if pumps (sign-aware: positive→hydro, negative→storage)
  b?: "c" | "d";      // battery: charging-only / discharging-only DUID
}

export type NemRegion = "NSW1" | "QLD1" | "VIC1" | "SA1" | "TAS1";
const NEM_REGIONS: readonly NemRegion[] = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"];

function isNemRegion(s: string): s is NemRegion {
  return (NEM_REGIONS as readonly string[]).includes(s);
}

const DUID_REGISTRY: Record<string, DuidEntry> = (registryJson as {
  duids: Record<string, DuidEntry>;
}).duids;

// Memoize the warning so we only log unmapped DUIDs once per process.
const _warnedUnmappedDuids = new Set<string>();

// ============================================================================
// SHARED — directory listing scrape
// ============================================================================

/**
 * Scrape the NEMWEB IIS-style directory listing for the latest ZIP whose
 * filename matches `pattern`. The directories are sorted lexicographically
 * by filename (which is `<YYYYMMDDHHMM>_<seq>`), so the last match is newest.
 */
async function findLatestZipUrl(
  baseUrl: string,
  pattern: RegExp,
): Promise<string> {
  const res = await fetch(baseUrl);
  if (!res.ok) {
    throw new Error(`AEMO directory ${baseUrl} returned ${res.status}`);
  }
  const html = await res.text();

  // Collect all matching filenames; keep the lexicographically last one.
  const matches = html.match(pattern);
  if (!matches || matches.length === 0) {
    throw new Error(`AEMO directory ${baseUrl} had no matching ZIP files`);
  }
  // Use a global regex to enumerate all hits, then sort.
  const all: string[] = [];
  const globalPattern = new RegExp(pattern.source, "g");
  let m: RegExpExecArray | null;
  while ((m = globalPattern.exec(html)) !== null) {
    all.push(m[0]);
  }
  all.sort();
  const latest = all[all.length - 1]!;
  return baseUrl.endsWith("/") ? `${baseUrl}${latest}` : `${baseUrl}/${latest}`;
}

/** Download + unzip a NEMWEB ZIP. Returns the single CSV body as a string. */
async function fetchAndUnzip(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AEMO ZIP ${url} returned ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(buf);
  const entry = Object.entries(files).find(([name]) =>
    name.toUpperCase().endsWith(".CSV"),
  );
  if (!entry) throw new Error(`AEMO ZIP ${url} contained no CSV`);
  return strFromU8(entry[1]);
}

// ============================================================================
// NEMDF CSV PARSER
// ============================================================================

interface NemdfTable {
  headers: string[];      // includes the leading "row type / package / table / version" cols
  rows: string[][];       // each row's full split — D-row, headers aligned by index
}

/**
 * Parse the NEMDF C/I/D multi-section CSV format. Returns a map keyed by
 * `<package>:<table>:<version>` — e.g. `DISPATCH:UNIT_SCADA:1`.
 *
 * `I,<package>,<table>,<version>,<col1>,<col2>,...` defines the section.
 * Subsequent `D,<package>,<table>,<version>,<val1>,...` rows are data rows
 * whose `<valN>` align with `<colN>` (so we strip the first 4 cols when
 * exposing rows).
 */
function parseNemdf(csv: string): Map<string, NemdfTable> {
  const tables = new Map<string, NemdfTable>();
  const lines = csv.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    if (!line || line.length === 0) continue;
    const cols = splitCsvLine(line);
    const rowType = cols[0];
    if (rowType === "C") continue;           // comment / header / footer
    if (rowType === "I") {
      const pkg = cols[1] ?? "";
      const tbl = cols[2] ?? "";
      const ver = cols[3] ?? "";
      currentKey = `${pkg}:${tbl}:${ver}`;
      tables.set(currentKey, {
        headers: cols.slice(4),
        rows: [],
      });
      continue;
    }
    if (rowType === "D" && currentKey) {
      // Confirm package/table/version match — defensive
      const pkg = cols[1] ?? "";
      const tbl = cols[2] ?? "";
      const ver = cols[3] ?? "";
      const key = `${pkg}:${tbl}:${ver}`;
      const table = tables.get(key);
      if (!table) continue;
      table.rows.push(cols.slice(4));
      continue;
    }
    // Other row types (e.g. row indicator changed) — ignore.
  }
  return tables;
}

/**
 * Split a single NEMDF CSV line. Handles bare commas, double-quoted fields
 * that may contain commas, and strips the surrounding quotes from the value.
 * NEMDF doesn't use embedded escaped quotes in dispatch reports.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Convert a NEMDF datetime literal (e.g. `2026/04/25 13:30:00`, in NEM time =
 * UTC+10 fixed) to a UTC Date. We do not use Intl tz — NEM has no DST while
 * Australia/Sydney does, so the Intl zone would skid 1h Oct–Apr.
 */
function nemTimeToUtc(s: string): Date {
  // Format: YYYY/MM/DD HH:MM:SS, possibly surrounded by whitespace.
  const trimmed = s.trim();
  const m = trimmed.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) throw new Error(`Bad NEM datetime: ${s}`);
  const [, yy, mo, dd, hh, mm, ss] = m;
  // Build a Date as if the wall clock were UTC, then subtract 10h to land at real UTC.
  const asUtc = Date.UTC(
    parseInt(yy!, 10),
    parseInt(mo!, 10) - 1,
    parseInt(dd!, 10),
    parseInt(hh!, 10),
    parseInt(mm!, 10),
    parseInt(ss!, 10),
  );
  return new Date(asUtc - 10 * 60 * 60 * 1000);
}

// ============================================================================
// PRICE — DispatchIS_Reports
// ============================================================================

const PRICE_DIR = "https://nemweb.com.au/Reports/Current/DispatchIS_Reports/";
const PRICE_PATTERN = /PUBLIC_DISPATCHIS_\d+_\d+\.zip/;

export interface AemoPriceTick {
  iso: "AEMO";
  zone: string;
  intervalStartUtc: string;
  intervalEndUtc: string;
  lmpUsdPerMwh: number;
  lmpAudPerMwh: number;
  market: "RTM";
  ts: string;
}

/**
 * AUD/USD env-overridable rate. TODO: live FX in V2 (daily ECB or similar).
 */
function audUsdRate(): number {
  const raw = process.env.AUD_USD_RATE;
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0.66;
}

export async function fetchAemoPrice(region: string): Promise<AemoPriceTick> {
  if (!isNemRegion(region)) {
    throw new Error(
      `Unknown AEMO region "${region}". Expected one of NSW1/QLD1/VIC1/SA1/TAS1.`,
    );
  }

  const zipUrl = await findLatestZipUrl(PRICE_DIR, PRICE_PATTERN);
  const csv = await fetchAndUnzip(zipUrl);
  const tables = parseNemdf(csv);

  // DispatchIS publishes regional price in `DREGION` for v3+; older NEMDF used
  // `PRICE`. We accept either: filter to (REGIONID, INTERVENTION=0) and read RRP.
  const candidateKeys = ["DISPATCH:DREGION:3", "DISPATCH:PRICE:3", "DISPATCH:PRICE:5"];
  let table: NemdfTable | undefined;
  let key: string | undefined;
  for (const k of tables.keys()) {
    if (k.startsWith("DISPATCH:DREGION:") || k.startsWith("DISPATCH:PRICE:")) {
      table = tables.get(k);
      key = k;
      break;
    }
  }
  // Fall back to the explicit candidates if the loose match missed.
  if (!table) {
    for (const k of candidateKeys) {
      if (tables.has(k)) {
        table = tables.get(k);
        key = k;
        break;
      }
    }
  }
  if (!table) {
    throw new Error(
      `AEMO DispatchIS missing DREGION/PRICE table; got ${[...tables.keys()].join(", ")}`,
    );
  }

  const headers = table.headers;
  const idx = {
    settlementDate: headers.indexOf("SETTLEMENTDATE"),
    regionId: headers.indexOf("REGIONID"),
    intervention: headers.indexOf("INTERVENTION"),
    rrp: headers.indexOf("RRP"),
  };
  if (idx.settlementDate < 0 || idx.regionId < 0 || idx.rrp < 0) {
    throw new Error(
      `AEMO DispatchIS ${key} missing required columns; headers=${headers.join(",")}`,
    );
  }

  const matching = table.rows.filter(r => {
    if (r[idx.regionId] !== region) return false;
    if (idx.intervention >= 0 && r[idx.intervention] !== "0") return false;
    return true;
  });
  if (matching.length === 0) {
    throw new Error(`AEMO DispatchIS had no rows for region ${region}`);
  }

  // Latest by SETTLEMENTDATE.
  matching.sort((a, b) =>
    (b[idx.settlementDate] ?? "").localeCompare(a[idx.settlementDate] ?? ""),
  );
  const latest = matching[0]!;
  const settle = latest[idx.settlementDate] ?? "";
  const rrpAud = parseFloat(latest[idx.rrp] ?? "0");

  // SETTLEMENTDATE is the interval END time (5-min interval).
  const intervalEnd = nemTimeToUtc(settle);
  const intervalStart = new Date(intervalEnd.getTime() - 5 * 60 * 1000);

  const fx = audUsdRate();
  return {
    iso: "AEMO",
    zone: region,
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc: intervalEnd.toISOString(),
    lmpUsdPerMwh: rrpAud * fx,
    lmpAudPerMwh: rrpAud,
    market: "RTM",
    ts: new Date().toISOString(),
  };
}

const priceCache = new Map<string, { at: number; tick: AemoPriceTick }>();
export async function getAemoPriceCached(region: string): Promise<AemoPriceTick> {
  const hit = priceCache.get(region);
  if (hit && Date.now() - hit.at < 60_000) return hit.tick;
  const tick = await fetchAemoPrice(region);
  priceCache.set(region, { at: Date.now(), tick });
  return tick;
}

// ============================================================================
// GENERATION MIX — Dispatch_SCADA
// ============================================================================

const SCADA_DIR = "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/";
const SCADA_PATTERN = /PUBLIC_DISPATCHSCADA_\d+_\d+\.zip/;

export interface AemoMixTick {
  iso: "AEMO";
  zone: string;
  intervalStartUtc: string;
  intervalEndUtc: string;
  mw: Partial<Record<FuelType, number>>;
  totalMw: number;
  unmappedDuids?: string[];
  ts: string;
}

/**
 * Region "AEMO" (case-insensitive) means system-wide — all regions aggregated.
 * Otherwise must be one of the 5 NEM regions.
 */
export async function fetchAemoMix(region: string): Promise<AemoMixTick> {
  const isSystem = region.toUpperCase() === "AEMO";
  if (!isSystem && !isNemRegion(region)) {
    throw new Error(
      `Unknown AEMO mix zone "${region}". Expected NEM region or "AEMO".`,
    );
  }

  const zipUrl = await findLatestZipUrl(SCADA_DIR, SCADA_PATTERN);
  const csv = await fetchAndUnzip(zipUrl);
  const tables = parseNemdf(csv);

  const scada = tables.get("DISPATCH:UNIT_SCADA:1");
  if (!scada) {
    throw new Error(
      `AEMO SCADA missing UNIT_SCADA table; got ${[...tables.keys()].join(", ")}`,
    );
  }

  const headers = scada.headers;
  const idx = {
    settlementDate: headers.indexOf("SETTLEMENTDATE"),
    duid: headers.indexOf("DUID"),
    scadaValue: headers.indexOf("SCADAVALUE"),
  };
  if (idx.settlementDate < 0 || idx.duid < 0 || idx.scadaValue < 0) {
    throw new Error(
      `AEMO SCADA missing columns; headers=${headers.join(",")}`,
    );
  }

  // Pick the latest SETTLEMENTDATE, then filter to that interval only.
  let latestStamp = "";
  for (const r of scada.rows) {
    const s = r[idx.settlementDate] ?? "";
    if (s > latestStamp) latestStamp = s;
  }
  if (!latestStamp) {
    throw new Error("AEMO SCADA had no rows");
  }
  const intervalRows = scada.rows.filter(
    r => r[idx.settlementDate] === latestStamp,
  );

  const mw: Partial<Record<FuelType, number>> = {};
  const unmappedThisCall: string[] = [];

  for (const r of intervalRows) {
    const duid = r[idx.duid] ?? "";
    if (!duid) continue;
    const rawValue = parseFloat(r[idx.scadaValue] ?? "0");
    if (!Number.isFinite(rawValue)) continue;

    const entry = DUID_REGISTRY[duid];

    // Region filter: skip out-of-region DUIDs unless system-wide.
    if (!isSystem) {
      if (!entry || entry.r !== region) {
        // No entry → can't tell its region; conservatively drop it.
        if (!entry) {
          if (!_warnedUnmappedDuids.has(duid)) {
            _warnedUnmappedDuids.add(duid);
            unmappedThisCall.push(duid);
          }
        }
        continue;
      }
    } else if (!entry) {
      if (!_warnedUnmappedDuids.has(duid)) {
        _warnedUnmappedDuids.add(duid);
        unmappedThisCall.push(duid);
      }
      // Unmapped → bucket as "other", preserve raw value.
      mw.other = (mw.other ?? 0) + rawValue;
      continue;
    }

    // Sign-aware fuel routing for storage-like DUIDs.
    let fuel: FuelType = entry.f;
    let value = rawValue;

    if (entry.p === 1) {
      // Pumped hydro: positive → hydro discharge, negative → storage charging.
      if (rawValue < 0) {
        fuel = "storage";
      } else {
        fuel = "hydro";
      }
    } else if (entry.b === "c") {
      // Charging-only battery DUID: SCADAVALUE is positive when charging from grid.
      // Grid402 storage convention: discharge positive, charge negative.
      fuel = "storage";
      value = -Math.abs(rawValue);
    } else if (entry.b === "d") {
      // Discharging-only battery DUID: positive value = discharge → keep as-is.
      fuel = "storage";
      value = Math.abs(rawValue);
    }

    mw[fuel] = (mw[fuel] ?? 0) + value;
  }

  if (unmappedThisCall.length > 0) {
    // Emit a single warn per session listing newly-seen unmapped DUIDs.
    console.warn(
      `[aemo] ${unmappedThisCall.length} unmapped DUID(s) (bucketed to "other" or dropped): ${unmappedThisCall.join(", ")}`,
    );
  }

  // totalMw = sum of generation, excluding storage net (which can be negative)
  // and imports (none in DUID feed). Mirrors caiso.ts convention.
  let totalMw = 0;
  for (const [fuel, value] of Object.entries(mw)) {
    if (fuel === "storage" || fuel === "imports") continue;
    if (value && value > 0) totalMw += value;
  }

  // Round all values to integers for response cleanliness.
  for (const k of Object.keys(mw) as FuelType[]) {
    const v = mw[k];
    if (v !== undefined) mw[k] = Math.round(v);
  }

  const intervalEnd = nemTimeToUtc(latestStamp);
  const intervalStart = new Date(intervalEnd.getTime() - 5 * 60 * 1000);

  return {
    iso: "AEMO",
    zone: isSystem ? "AEMO" : region,
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc: intervalEnd.toISOString(),
    mw,
    totalMw: Math.round(totalMw),
    ...(unmappedThisCall.length > 0 ? { unmappedDuids: unmappedThisCall } : {}),
    ts: new Date().toISOString(),
  };
}

const mixCache = new Map<string, { at: number; tick: AemoMixTick }>();
export async function getAemoMixCached(region: string): Promise<AemoMixTick> {
  const key = region.toUpperCase();
  const hit = mixCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.tick;
  const tick = await fetchAemoMix(region);
  mixCache.set(key, { at: Date.now(), tick });
  return tick;
}
