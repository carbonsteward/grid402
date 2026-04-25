// KPX (Korea Power Exchange) fetchers — price (SMP) and generation mix.
//
// Three upstream paths:
//
//   Phase 0 — HTML scrape (no auth, immediate use):
//     SMP:  https://new.kpx.or.kr/smpInland.es?mid=a10606080100&device=pc
//     Mix:  https://new.kpx.or.kr/powerinfoSubmain.es?mid=a10606030000
//
//   Phase 1 — data.go.kr OpenAPI (ServiceKey via auto-approval):
//     5-min mix: https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m
//
// MVP covers 본토 (mainland) only — zone "KR". Jeju is V2.
// Korea uses uniform pricing (single SMP, no nodal LMPs); we expose the system
// price under the requested zone parameter for symmetry with CAISO.
//
// Note: fast-xml-parser is not yet listed in api/package.json — must be added
// before this module compiles outside this file. Phase 0 endpoints work today
// without that dep.

import { XMLParser } from "fast-xml-parser";
import type { FuelType } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const KST_OFFSET_HOURS = 9;             // Korea Standard Time = UTC+9, no DST
const SMP_HTML_URL =
  "https://new.kpx.or.kr/smpInland.es?mid=a10606080100&device=pc";
const MIX_HTML_URL =
  "https://new.kpx.or.kr/powerinfoSubmain.es?mid=a10606030000";
const MIX_OPENAPI_URL =
  "https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m";

// TODO: replace with live FX in V2 (lib/fx.ts daily-cached KRW→USD).
const DEFAULT_KRW_USD_RATE = 1380;

function getKrwUsdRate(): number {
  const raw = process.env.KRW_USD_RATE;
  if (!raw) return DEFAULT_KRW_USD_RATE;
  const parsed = parseFloat(raw);
  return isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KRW_USD_RATE;
}

// Convert a "today" KST hour-of-day (0..23) into a UTC top-of-hour Date,
// falling back to the previous day if the requested hour hasn't occurred yet
// in KST (e.g. table shows hours 1..H where H is the current KST hour).
function kstHourToUtcTopOfHour(hour: number): Date {
  const now = new Date();
  // Current KST wall clock
  const kstNowMs = now.getTime() + KST_OFFSET_HOURS * 3600 * 1000;
  const kstNow = new Date(kstNowMs);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  // KST hour H corresponds to UTC = (H - 9) mod 24, possibly previous day.
  const utcHour = ((hour - KST_OFFSET_HOURS) % 24 + 24) % 24;
  const dayOffset = hour - KST_OFFSET_HOURS < 0 ? -1 : 0;
  return new Date(Date.UTC(y, m, d + dayOffset, utcHour, 0, 0));
}

// ============================================================================
// PRICE — Phase 0 SMP HTML scrape
// ============================================================================

export interface KpxPriceTick {
  iso: "KPX";
  zone: "KR";                  // 육지 only for MVP; jeju V2
  intervalStartUtc: string;    // ISO-8601, top-of-hour UTC
  intervalEndUtc: string;
  lmpUsdPerMwh: number;
  lmpKrwPerKwh: number;        // preserve original SMP value
  market: "RTM";
  ts: string;                  // fetched-at
}

/**
 * Scrape today's most recent hourly SMP from new.kpx.or.kr.
 * Returns the latest non-zero hourly value as a price tick.
 *
 * SMP table layout (육지): rows = hour-of-day (1..24, 시간 column), columns =
 * recent dates with the leftmost column being today. Values are KRW/kWh
 * (e.g. "143.21"). We pick the highest hour for which today's column is
 * populated and non-zero.
 */
export async function fetchKpxSmpHourly(): Promise<KpxPriceTick> {
  const res = await fetch(SMP_HTML_URL, {
    headers: {
      // KPX is occasionally fussy without a UA.
      "User-Agent": "Grid402/0.1 (+https://github.com/grid402)",
      "Accept": "text/html",
    },
  });
  if (!res.ok) throw new Error(`KPX SMP HTML returned ${res.status}`);
  const html = await res.text();

  // The page renders a 7-day × 24-hour table. The structure historically is:
  //   <tr><th>1</th><td>{today}</td><td>{D-1}</td>...<td>{avg}</td></tr>
  //   <tr><th>2</th><td>{today}</td>...
  // We extract hour-keyed rows where the first <td> after the <th> is today.
  // Strategy: regex for each <tr> containing a numeric <th> 1..24, capture the
  // first <td>'s text content, and choose the latest hour whose value parses
  // to a positive float.
  const rowRe =
    /<tr[^>]*>\s*<th[^>]*>\s*(\d{1,2})\s*<\/th>\s*<td[^>]*>\s*([0-9,.\-]+)\s*<\/td>/gi;

  const todayByHour = new Map<number, number>();
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const hour = parseInt(match[1] ?? "0", 10);
    if (!hour || hour < 1 || hour > 24) continue;
    const valStr = (match[2] ?? "").replace(/,/g, "");
    const val = parseFloat(valStr);
    if (!isFinite(val)) continue;
    todayByHour.set(hour, val);
  }

  if (todayByHour.size === 0) {
    throw new Error("KPX SMP HTML: no hourly rows parsed (page layout changed?)");
  }

  // KPX uses 1..24 (hour-ending). Find the latest hour whose value > 0
  // (overnight hours can be 0 only on edge days — guard regardless).
  const sortedHours = [...todayByHour.keys()].sort((a, b) => b - a);
  let pickedHour: number | null = null;
  let pickedKrwPerKwh: number | null = null;
  for (const h of sortedHours) {
    const v = todayByHour.get(h);
    if (v !== undefined && v > 0) {
      pickedHour = h;
      pickedKrwPerKwh = v;
      break;
    }
  }
  if (pickedHour === null || pickedKrwPerKwh === null) {
    throw new Error("KPX SMP HTML: no positive hourly value found");
  }

  const fxRate = getKrwUsdRate();
  // SMP is hour-ending; interval start is (pickedHour - 1) KST.
  const intervalStart = kstHourToUtcTopOfHour(pickedHour - 1);
  const intervalEnd = new Date(intervalStart.getTime() + 3600 * 1000);

  return {
    iso: "KPX",
    zone: "KR",
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc: intervalEnd.toISOString(),
    lmpUsdPerMwh: (pickedKrwPerKwh * 1000) / fxRate,
    lmpKrwPerKwh: pickedKrwPerKwh,
    market: "RTM",
    ts: new Date().toISOString(),
  };
}

const priceCache = new Map<string, { at: number; tick: KpxPriceTick }>();

/**
 * 60s-TTL cache wrapper around fetchKpxSmpHourly. Zone is currently ignored
 * (always "KR") but parameterized to mirror the CAISO API and to ease V2
 * jeju support.
 */
export async function getKpxPriceCached(
  zone: string = "KR",
): Promise<KpxPriceTick> {
  const key = zone;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.tick;
  const tick = await fetchKpxSmpHourly();
  priceCache.set(key, { at: Date.now(), tick });
  return tick;
}

// ============================================================================
// MIX — shared types
// ============================================================================

export interface KpxMixTick {
  iso: "KPX";
  zone: "KR";
  intervalStartUtc: string;
  intervalEndUtc: string;
  mw: Partial<Record<FuelType, number>>;
  totalMw: number;
  ts: string;
}

// ============================================================================
// MIX — Phase 1 OpenAPI 5-min (the crown jewel)
// ============================================================================

/**
 * Parse a "YYYYMMDDhhmmss" KST timestamp into a UTC Date.
 */
function kpxBaseDatetimeToUtc(s: string): Date {
  const str = String(s);
  if (!/^\d{14}$/.test(str)) throw new Error(`Invalid baseDatetime: ${str}`);
  const y = parseInt(str.slice(0, 4), 10);
  const mo = parseInt(str.slice(4, 6), 10) - 1;
  const d = parseInt(str.slice(6, 8), 10);
  const h = parseInt(str.slice(8, 10), 10);
  const mi = parseInt(str.slice(10, 12), 10);
  const se = parseInt(str.slice(12, 14), 10);
  // KST → UTC: subtract 9 hours.
  return new Date(Date.UTC(y, mo, d, h - KST_OFFSET_HOURS, mi, se));
}

function num(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Fetch and parse the KPX 5-min fuel-mix OpenAPI. Requires ServiceKey from
 * data.go.kr (auto-approval — see kr_korea.md §2.1). Throws a clear, actionable
 * error when the env var is not set.
 *
 * Mapping of the 13 fuel fields (see kr_korea.md §3.1):
 *   nuclear  = fuelPwr4
 *   coal     = fuelPwr3 + fuelPwr7   (유연탄 + 국내탄/무연탄)
 *   gas      = fuelPwr6 (LNG)
 *   oil      = fuelPwr2
 *   hydro    = fuelPwr1
 *   storage  = fuelPwr5 (양수; positive = discharge)
 *   solar    = fuelPwr8 (시장)
 *   wind     = fuelPwr9
 *   other    = fuelPwr10 (신재생: bio + fuel-cell + …) + pEsmw + bEmsw (PPA + BTM estimates)
 */
export async function fetchKpxMix5Min(): Promise<KpxMixTick> {
  const key = process.env.KPX_OPENAPI_KEY;
  if (!key) {
    throw new Error(
      "KPX_OPENAPI_KEY is not set. Get one (free, auto-approval, ~minutes) " +
      "from https://www.data.go.kr — search 'KPX 5분 연료원별 발전' or " +
      "'sumperfuel5m', click 활용신청, then set KPX_OPENAPI_KEY to the " +
      "raw (non-URL-encoded) ServiceKey from your data.go.kr 마이페이지. " +
      "Until then the hourly HTML fallback (fetchKpxMixHourlyFallback) is used.",
    );
  }

  // ServiceKey must be raw (un-encoded). URLSearchParams will encode the rest.
  const params = new URLSearchParams({
    numOfRows: "10",
    pageNo: "1",
    dataType: "XML",
  });
  const url =
    `${MIX_OPENAPI_URL}?serviceKey=${encodeURIComponent(key)}&${params.toString()}`;

  const res = await fetch(url, {
    headers: { "Accept": "application/xml" },
  });
  if (!res.ok) throw new Error(`KPX OpenAPI returned ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: true,
    trimValues: true,
  });
  const parsed: unknown = parser.parse(xml);

  // Walk down to <items><item>…</item></items>. Some KPX endpoints wrap with
  // <response><body><items><item>…, others with <tbAllSumperfuel5mResponse>.
  const items = extractItems(parsed);
  if (!items || items.length === 0) {
    // Surface result-code text if present (e.g. "SERVICE KEY IS NOT REGISTERED").
    const headerMsg = extractResultMessage(parsed);
    throw new Error(
      `KPX OpenAPI returned no items${headerMsg ? `: ${headerMsg}` : ""}`,
    );
  }

  // Latest interval = item with max baseDatetime.
  const latest = items
    .slice()
    .sort((a, b) =>
      String(b.baseDatetime ?? "").localeCompare(String(a.baseDatetime ?? "")),
    )[0]!;

  const baseDt = String(latest.baseDatetime ?? "");
  const intervalStart = kpxBaseDatetimeToUtc(baseDt);
  const intervalEnd = new Date(intervalStart.getTime() + 5 * 60 * 1000);

  const fp1 = num(latest.fuelPwr1);
  const fp2 = num(latest.fuelPwr2);
  const fp3 = num(latest.fuelPwr3);
  const fp4 = num(latest.fuelPwr4);
  const fp5 = num(latest.fuelPwr5);
  const fp6 = num(latest.fuelPwr6);
  const fp7 = num(latest.fuelPwr7);
  const fp8 = num(latest.fuelPwr8);
  const fp9 = num(latest.fuelPwr9);
  const fp10 = num(latest.fuelPwr10);
  const pEsmw = num(latest.pEsmw);
  const bEmsw = num(latest.bEmsw);

  const mw: Partial<Record<FuelType, number>> = {
    nuclear: nonNeg(fp4),
    coal:    nonNeg(fp3 + fp7),
    gas:     nonNeg(fp6),
    oil:     nonNeg(fp2),
    hydro:   nonNeg(fp1),
    storage: fp5,                           // signed: + = discharge, - = charge
    solar:   nonNeg(fp8),                   // 시장 거래분만
    wind:    nonNeg(fp9),
    other:   nonNeg(fp10 + pEsmw + bEmsw),  // 신재생 + PPA/BTM 추정
  };

  // Total generation = positive MW excluding storage (storage is net/signed).
  let totalMw = 0;
  for (const [fuel, value] of Object.entries(mw)) {
    if (fuel === "storage") continue;
    if (value && value > 0) totalMw += value;
  }

  return {
    iso: "KPX",
    zone: "KR",
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc: intervalEnd.toISOString(),
    mw,
    totalMw: Math.round(totalMw),
    ts: new Date().toISOString(),
  };
}

function nonNeg(n: number): number {
  return n > 0 ? n : 0;
}

// Generic shape of a parsed KPX item row; values arrive as numbers or strings.
type KpxItem = {
  baseDatetime?: string | number;
  fuelPwr1?: string | number;
  fuelPwr2?: string | number;
  fuelPwr3?: string | number;
  fuelPwr4?: string | number;
  fuelPwr5?: string | number;
  fuelPwr6?: string | number;
  fuelPwr7?: string | number;
  fuelPwr8?: string | number;
  fuelPwr9?: string | number;
  fuelPwr10?: string | number;
  pEsmw?: string | number;
  bEmsw?: string | number;
  fuelPwrTot?: string | number;
};

/**
 * Drill into a parsed KPX OpenAPI XML payload to extract the item array.
 * Robust to multiple known wrapper shapes (response/body/items vs.
 * tbAllSumperfuel5mResponse/items).
 */
function extractItems(parsed: unknown): KpxItem[] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const visit = (node: unknown): KpxItem[] | null => {
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    // Direct hit: { items: { item: ... } }
    const items = obj["items"];
    if (items && typeof items === "object") {
      const item = (items as Record<string, unknown>)["item"];
      if (Array.isArray(item)) return item as KpxItem[];
      if (item && typeof item === "object") return [item as KpxItem];
    }
    // Recurse into children.
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const r = visit(v);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(parsed);
}

function extractResultMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const visit = (node: unknown): string | null => {
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    const msg = obj["resultMsg"] ?? obj["resultMessage"];
    if (typeof msg === "string" && msg.length > 0) return msg;
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const r = visit(v);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(parsed);
}

// ============================================================================
// MIX — Phase 0 hourly HTML fallback
// ============================================================================

// HTML labels seen on powerinfoSubmain.es (한글 captions next to MW values).
// Keep these flexible — the page intermixes them with totals/capacities.
const HTML_FUEL_LABEL_MAP: Array<{ pattern: RegExp; fuel: FuelType }> = [
  { pattern: /원자력/,         fuel: "nuclear" },
  { pattern: /유연탄|무연탄|국내탄|석탄/, fuel: "coal" },
  { pattern: /가스|LNG/i,      fuel: "gas" },
  { pattern: /유류|석유/,      fuel: "oil" },
  { pattern: /양수/,           fuel: "storage" },
  { pattern: /수력/,           fuel: "hydro" },
  { pattern: /태양광/,         fuel: "solar" },
  { pattern: /풍력/,           fuel: "wind" },
  { pattern: /신재생/,         fuel: "other" },
];

/**
 * Fallback when KPX_OPENAPI_KEY isn't set: scrape the hourly fuel mix from
 * new.kpx.or.kr/powerinfoSubmain.es. The page is a Korean-language HTML
 * dashboard with 9 fuel rows. We extract MW values keyed by Korean labels.
 *
 * This is hourly granularity (not 5-min) — interval is 60 minutes.
 */
export async function fetchKpxMixHourlyFallback(): Promise<KpxMixTick> {
  const res = await fetch(MIX_HTML_URL, {
    headers: {
      "User-Agent": "Grid402/0.1 (+https://github.com/grid402)",
      "Accept": "text/html",
    },
  });
  if (!res.ok) throw new Error(`KPX mix HTML returned ${res.status}`);
  const html = await res.text();

  const mw: Partial<Record<FuelType, number>> = {};

  // The page uses several layouts; try a few scrape strategies and merge.
  // Strategy A: <th>{label}</th>...<td>{value}</td>  pairs in table rows.
  const rowRe =
    /<t[hd][^>]*>\s*([^<>]{1,40}?)\s*<\/t[hd]>\s*<t[hd][^>]*>\s*([\d,.\-]+)\s*(?:MW)?\s*<\/t[hd]>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const label = (m[1] ?? "").trim();
    const valStr = (m[2] ?? "").replace(/,/g, "");
    if (!label || !valStr) continue;
    const value = parseFloat(valStr);
    if (!isFinite(value)) continue;
    for (const { pattern, fuel } of HTML_FUEL_LABEL_MAP) {
      if (pattern.test(label)) {
        mw[fuel] = (mw[fuel] ?? 0) + value;
        break;
      }
    }
  }

  // Strategy B: inline "<span>{label}</span> ... <strong>{value}</strong>".
  if (Object.keys(mw).length === 0) {
    const spanRe =
      /<span[^>]*>\s*([^<>]{1,40}?)\s*<\/span>[\s\S]{0,200}?<(?:strong|em|b)[^>]*>\s*([\d,.\-]+)\s*(?:MW)?\s*<\/(?:strong|em|b)>/gi;
    while ((m = spanRe.exec(html)) !== null) {
      const label = (m[1] ?? "").trim();
      const valStr = (m[2] ?? "").replace(/,/g, "");
      const value = parseFloat(valStr);
      if (!isFinite(value)) continue;
      for (const { pattern, fuel } of HTML_FUEL_LABEL_MAP) {
        if (pattern.test(label)) {
          mw[fuel] = (mw[fuel] ?? 0) + value;
          break;
        }
      }
    }
  }

  if (Object.keys(mw).length === 0) {
    throw new Error(
      "KPX mix HTML: no fuel rows parsed (layout changed?). " +
      "Set KPX_OPENAPI_KEY to use the OpenAPI path.",
    );
  }

  // Clamp negatives (page-published mix should never be negative; storage
  // sign convention isn't reliably exposed in the HTML view).
  for (const fuel of Object.keys(mw) as FuelType[]) {
    const v = mw[fuel];
    if (v !== undefined && v < 0) mw[fuel] = 0;
  }

  let totalMw = 0;
  for (const [fuel, value] of Object.entries(mw)) {
    if (fuel === "storage") continue;
    if (value && value > 0) totalMw += value;
  }

  // Anchor interval to the most recent top-of-hour UTC.
  const now = new Date();
  const intervalStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0, 0,
    ),
  );
  const intervalEnd = new Date(intervalStart.getTime() + 3600 * 1000);

  return {
    iso: "KPX",
    zone: "KR",
    intervalStartUtc: intervalStart.toISOString(),
    intervalEndUtc: intervalEnd.toISOString(),
    mw,
    totalMw: Math.round(totalMw),
    ts: new Date().toISOString(),
  };
}

// ============================================================================
// MIX — cache wrapper (5-min OpenAPI primary, hourly HTML fallback)
// ============================================================================

let mixCache: { at: number; tick: KpxMixTick } | null = null;

/**
 * 60s-TTL cache wrapper. Tries the OpenAPI 5-min path first; on failure (or
 * when KPX_OPENAPI_KEY is unset), falls back to hourly HTML scraping. The
 * caller receives a unified `KpxMixTick` either way.
 */
export async function getKpxMixCached(): Promise<KpxMixTick> {
  if (mixCache && Date.now() - mixCache.at < 60_000) return mixCache.tick;

  let tick: KpxMixTick;
  if (process.env.KPX_OPENAPI_KEY) {
    try {
      tick = await fetchKpxMix5Min();
    } catch (err) {
      // Phase 0 fallback — log & keep going so the API stays responsive.
      console.warn(
        `[kpx] OpenAPI 5-min failed, falling back to hourly HTML: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      tick = await fetchKpxMixHourlyFallback();
    }
  } else {
    tick = await fetchKpxMixHourlyFallback();
  }

  mixCache = { at: Date.now(), tick };
  return tick;
}
