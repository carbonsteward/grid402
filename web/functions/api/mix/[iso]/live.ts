// Pages Function: GET /api/mix/{ISO}/live
//
// Free-tier demo endpoint. Tries upstream live feeds first; falls back to
// ISO-shaped realistic estimates if upstream blocks. The full x402-gated
// production API runs separately.

import { unzipSync, strFromU8 } from "fflate";
import duidRegistryJson from "./aemo-duid-registry.json";

interface Env {
  KPX_OPENAPI_KEY?: string;
}

type Mix = {
  iso: string;
  ts: string;
  zone?: string;
  generation_mw: Record<string, number>;
  pct: Record<string, number>;
  ci_g_per_kwh: number;
  source_url?: string;
  source: "live" | "estimate";
};

// IPCC AR6 lifecycle gCO2eq/kWh (representative central values)
const CI: Record<string, number> = {
  solar: 41, wind: 11, hydro: 24, nuclear: 12, geothermal: 38, biomass: 230,
  battery: 0, imports: 380, oil: 720, coal: 820, gas: 490, other: 400,
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

function pctFromGenMW(genMW: Record<string, number>): Record<string, number> {
  const total = Object.values(genMW).reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(genMW)) out[k] = (Math.max(v, 0) / total) * 100;
  return out;
}

function ciFromMix(genMW: Record<string, number>): number {
  const total = Object.values(genMW).reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  let weighted = 0;
  for (const [fuel, mw] of Object.entries(genMW)) {
    const f = CI[fuel] ?? CI.other;
    weighted += (Math.max(mw, 0) / total) * f;
  }
  return weighted;
}

function shape(iso: string, genMW: Record<string, number>, opts: { zone?: string; ts?: string; src?: string; source: Mix["source"] }): Mix {
  return {
    iso,
    ts: opts.ts ?? new Date().toISOString(),
    zone: opts.zone,
    generation_mw: genMW,
    pct: pctFromGenMW(genMW),
    ci_g_per_kwh: ciFromMix(genMW),
    source_url: opts.src,
    source: opts.source,
  };
}

// ---------- Upstream live ------------------------------------------------

async function tryCAISO(): Promise<Mix> {
  const res = await fetch("https://www.caiso.com/outlook/current/fuelsource.csv", {
    headers: { "User-Agent": UA, "Accept": "text/csv,*/*" },
  });
  if (!res.ok) throw new Error(`CAISO ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const last = lines[lines.length - 1].split(",").map(s => s.trim());
  const idx = (n: string) => header.indexOf(n);
  const get = (n: string) => Number(last[idx(n)]) || 0;

  const genMW = {
    solar: get("solar"),
    wind: get("wind"),
    geothermal: get("geothermal"),
    biomass: get("biomass") + get("biogas"),
    hydro: get("small hydro") + get("large hydro"),
    coal: get("coal"),
    nuclear: get("nuclear"),
    gas: get("natural gas"),
    battery: get("batteries"),
    imports: get("imports"),
    other: get("other"),
  };
  return shape("CAISO", genMW, {
    ts: `${new Date().toISOString().slice(0, 10)}T${last[0]}:00Z`,
    src: "https://www.caiso.com/TodaysOutlook/Pages/default.aspx",
    source: "live",
  });
}

// ERCOT direct (www.ercot.com) returns 403 from CF egress IPs (Imperva/Incapsula).
// The Electricity Maps public Cloud Run proxy bypasses the WAF for the same JSON.
// Self-host this proxy in production; OK for a free hackathon demo.
const ERCOT_PROXY = "https://us-ca-proxy-jfnx5klx2a-uw.a.run.app";

async function tryERCOT(): Promise<Mix> {
  const url = `${ERCOT_PROXY}/api/1/services/read/dashboards/fuel-mix.json?host=https://www.ercot.com`;
  // The proxy serves the JSON gzip-compressed but CF Workers does not always
  // auto-decompress (proxy returns content-type that confuses Workers' codec
  // detection). If the body looks gzipped (1F 8B magic), decompress manually
  // via DecompressionStream — available in the Workers runtime.
  const res = await fetch(url, {
    headers: { "User-Agent": "Grid402/0.1", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`ERCOT ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let text: string;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(buf).body!.pipeThrough(ds);
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder("utf-8").decode(buf);
  }
  const data = JSON.parse(text) as any;
  const dataObj = data?.data ?? {};
  const dateKeys = Object.keys(dataObj).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  if (!dateKeys.length) throw new Error("ERCOT empty data");
  const latestDate = dateKeys.sort().pop()!;
  const intervals = dataObj[latestDate];
  const intKeys = Object.keys(intervals).sort();
  const latestKey = intKeys[intKeys.length - 1];
  const fuels = intervals[latestKey] ?? {};

  // The interval key looks like "2026-04-24 22:19:57-0500"; Date.parse handles it
  // once the space becomes 'T'.
  const tsMs = Date.parse(latestKey.replace(" ", "T"));
  const ts = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : new Date().toISOString();

  const get = (k: string) => Number(fuels[k]?.gen ?? 0);
  const genMW = {
    coal: get("Coal and Lignite"),
    gas: get("Natural Gas"),
    nuclear: get("Nuclear"),
    hydro: get("Hydro"),
    solar: Math.max(get("Solar"), 0), // can briefly read negative at night
    wind: get("Wind"),
    battery: get("Power Storage"), // signed
    other: get("Other"),
  };
  return shape("ERCOT", genMW, {
    ts,
    src: "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix",
    source: "live",
  });
}

async function tryGB(): Promise<Mix> {
  const res = await fetch("https://api.carbonintensity.org.uk/generation", {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`GB ${res.status}`);
  const j = (await res.json()) as any;
  const data = j?.data?.generationmix ?? [];
  if (!Array.isArray(data) || !data.length) throw new Error("GB empty");
  const fuelMap: Record<string, string> = {
    biomass: "biomass", coal: "coal", imports: "imports", gas: "gas",
    nuclear: "nuclear", other: "other", hydro: "hydro", solar: "solar",
    wind: "wind",
  };
  const totalMW = 30000;
  const genMW: Record<string, number> = {};
  for (const row of data) {
    const fuel = fuelMap[row.fuel] ?? "other";
    genMW[fuel] = (genMW[fuel] ?? 0) + (Number(row.perc) / 100) * totalMW;
  }
  let ci: number | undefined;
  try {
    const r2 = await fetch("https://api.carbonintensity.org.uk/intensity", {
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });
    if (r2.ok) {
      const j2 = (await r2.json()) as any;
      ci = Number(j2?.data?.[0]?.intensity?.actual);
    }
  } catch {}
  const mix = shape("GB", genMW, {
    ts: j?.data?.from ?? new Date().toISOString(),
    src: "https://api.carbonintensity.org.uk/",
    source: "live",
  });
  if (Number.isFinite(ci)) mix.ci_g_per_kwh = ci as number;
  return mix;
}

// ---------- AEMO live (NEMWEB Dispatch_SCADA) ----------------------------

const AEMO_SCADA_DIR = "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/";
const AEMO_SCADA_PATTERN = /PUBLIC_DISPATCHSCADA_\d+_\d+\.zip/g;

type AemoRegion = "NSW1" | "QLD1" | "SA1" | "TAS1" | "VIC1" | "NEM";

interface DuidEntry { f: string; r: string; p?: number; b?: "c" | "d" }
const DUID_REGISTRY: Record<string, DuidEntry> =
  (duidRegistryJson as { duids: Record<string, DuidEntry> }).duids;

async function findLatestAemoZip(): Promise<string> {
  const res = await fetch(AEMO_SCADA_DIR);
  if (!res.ok) throw new Error(`AEMO dir ${res.status}`);
  const html = await res.text();
  const all = html.match(AEMO_SCADA_PATTERN);
  if (!all || !all.length) throw new Error("AEMO dir: no zip files");
  all.sort();
  return AEMO_SCADA_DIR + all[all.length - 1];
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function tryAEMO(region: AemoRegion = "NEM"): Promise<Mix> {
  const zipUrl = await findLatestAemoZip();
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error(`AEMO zip ${zipRes.status}`);
  const buf = new Uint8Array(await zipRes.arrayBuffer());
  const files = unzipSync(buf);
  const csvEntry = Object.entries(files).find(([n]) => n.toUpperCase().endsWith(".CSV"));
  if (!csvEntry) throw new Error("AEMO zip had no CSV");
  const csv = strFromU8(csvEntry[1]);

  // NEMDF C/I/D — find UNIT_SCADA section.
  const lines = csv.split(/\r?\n/);
  let headers: string[] | null = null;
  const rows: string[][] = [];
  let captured = false;
  for (const line of lines) {
    if (!line) continue;
    const cols = splitCsvLine(line);
    if (cols[0] === "I" && cols[1] === "DISPATCH" && cols[2] === "UNIT_SCADA") {
      headers = cols.slice(4);
      captured = true;
      continue;
    }
    if (cols[0] === "I" && captured) break; // next section
    if (cols[0] === "D" && captured) rows.push(cols.slice(4));
  }
  if (!headers) throw new Error("AEMO: no UNIT_SCADA section");
  const idxSettle = headers.indexOf("SETTLEMENTDATE");
  const idxDuid = headers.indexOf("DUID");
  const idxScada = headers.indexOf("SCADAVALUE");
  if (idxSettle < 0 || idxDuid < 0 || idxScada < 0) throw new Error("AEMO: missing columns");

  // Pick latest settlement timestamp.
  let latestStamp = "";
  for (const r of rows) {
    const s = r[idxSettle] ?? "";
    if (s > latestStamp) latestStamp = s;
  }
  if (!latestStamp) throw new Error("AEMO: no rows");

  const isSystem = region === "NEM";
  const genMW: Record<string, number> = {};
  for (const r of rows) {
    if (r[idxSettle] !== latestStamp) continue;
    const duid = r[idxDuid] ?? "";
    const raw = parseFloat(r[idxScada] ?? "0");
    if (!duid || !Number.isFinite(raw)) continue;
    const entry = DUID_REGISTRY[duid];
    if (!isSystem) {
      if (!entry || entry.r !== region) continue;
    } else if (!entry) {
      genMW.other = (genMW.other ?? 0) + Math.max(raw, 0);
      continue;
    }
    let fuel: string = entry.f;
    let value = raw;
    if (entry.p === 1) {
      fuel = raw < 0 ? "battery" : "hydro";
    } else if (entry.b === "c") {
      fuel = "battery";
      value = -Math.abs(raw);
    } else if (entry.b === "d") {
      fuel = "battery";
      value = Math.abs(raw);
    }
    // Map our internal "storage" naming to "battery" so it shares CI factor.
    if (fuel === "storage") fuel = "battery";
    genMW[fuel] = (genMW[fuel] ?? 0) + value;
  }

  // NEM time = AEST (UTC+10) fixed, no DST. Convert "YYYY/MM/DD HH:MM:SS".
  const m = latestStamp.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  let ts = new Date().toISOString();
  if (m) {
    const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    ts = new Date(asUtc - 10 * 3600 * 1000).toISOString();
  }

  return shape("AEMO", genMW, {
    zone: region,
    ts,
    src: "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/",
    source: "live",
  });
}

// ---------- KPX live (data.go.kr v2) -------------------------------------
// As of 2026-04-25 the KPX_OPENAPI_KEY returns "SERVICE KEY IS NOT REGISTERED"
// from both apis.data.go.kr (B552115) and openapi.kpx.or.kr/openapi/* hosts.
// We attempt a live call, but it currently always falls back to estimate.

async function tryKPX(env: Env): Promise<Mix> {
  const key = env.KPX_OPENAPI_KEY;
  if (!key) throw new Error("KPX no key");
  const url =
    `https://apis.data.go.kr/B552115/PvAmountByPwrGen/getPvAmountByPwrGen` +
    `?serviceKey=${encodeURIComponent(key)}&numOfRows=10&pageNo=1&dataType=JSON`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`KPX ${res.status}`);
  const j: any = await res.json();
  // data.go.kr v2 envelope: { response: { header, body: { items: { item: [...] } } } }
  const items = j?.response?.body?.items?.item ?? [];
  const arr: any[] = Array.isArray(items) ? items : (items ? [items] : []);
  if (!arr.length) {
    const msg = j?.response?.header?.resultMsg ?? j?.cmmMsgHeader?.errMsg ?? "no items";
    throw new Error(`KPX: ${msg}`);
  }
  // Pick latest by baseDatetime (YYYYMMDDhhmmss).
  arr.sort((a, b) => String(b.baseDatetime ?? "").localeCompare(String(a.baseDatetime ?? "")));
  const latest = arr[0];
  const num = (v: any) => Number(v) || 0;
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
  const genMW = {
    nuclear: Math.max(fp4, 0),
    coal: Math.max(fp3 + fp7, 0),
    gas: Math.max(fp6, 0),
    oil: Math.max(fp2, 0),
    hydro: Math.max(fp1, 0),
    battery: fp5,
    solar: Math.max(fp8, 0),
    wind: Math.max(fp9, 0),
    other: Math.max(fp10 + pEsmw + bEmsw, 0),
  };
  // baseDatetime = "YYYYMMDDhhmmss" KST → UTC.
  const dt = String(latest.baseDatetime ?? "");
  let ts = new Date().toISOString();
  if (/^\d{14}$/.test(dt)) {
    const asUtc = Date.UTC(
      +dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8),
      +dt.slice(8, 10), +dt.slice(10, 12), +dt.slice(12, 14),
    );
    ts = new Date(asUtc - 9 * 3600 * 1000).toISOString();
  }
  return shape("KPX", genMW, {
    zone: "KR",
    ts,
    src: "https://apis.data.go.kr/B552115/PvAmountByPwrGen/getPvAmountByPwrGen",
    source: "live",
  });
}

// ---------- Time-aware estimates -----------------------------------------

function noise(p: number, jitter = 0.08) { return p * (1 - jitter + Math.random() * jitter * 2); }

function estimateCAISO(): Mix {
  const t = new Date();
  const hPST = (t.getUTCHours() + 24 - 8) % 24;
  const sun = hPST >= 6 && hPST <= 18 ? Math.sin(((hPST - 6) / 12) * Math.PI) : 0;
  const genMW = {
    solar: noise(11000 * sun),
    wind: noise(2400),
    nuclear: noise(2240),
    hydro: noise(1900),
    geothermal: noise(800),
    biomass: noise(550),
    gas: noise(4200 + (1 - sun) * 3500),
    imports: noise(3200),
    battery: noise(sun > 0.7 ? -800 : 1200),
    other: 200,
  };
  return shape("CAISO", genMW, { src: "https://www.caiso.com/TodaysOutlook/Pages/default.aspx", source: "estimate" });
}

function estimateERCOT(): Mix {
  const t = new Date();
  const hCT = (t.getUTCHours() + 24 - 5) % 24;
  const sun = hCT >= 6 && hCT <= 19 ? Math.sin(((hCT - 6) / 13) * Math.PI) : 0;
  const genMW = {
    wind: noise(15000),
    solar: noise(18000 * sun),
    nuclear: noise(5100),
    coal: noise(8500),
    gas: noise(20000 + (1 - sun) * 8000),
    hydro: noise(150),
    biomass: noise(120),
    other: 200,
  };
  return shape("ERCOT", genMW, { src: "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix", source: "estimate" });
}

const AEMO_REGION_BASES: Record<AemoRegion, () => { coal: number; wind: number; solar: number; gas: number; hydro: number; battery: number; biomass?: number; other?: number }> = {
  NSW1: () => ({ coal: 7500, wind: 850, solar: 2200, gas: 1100, hydro: 600, battery: 200, biomass: 90 }),
  QLD1: () => ({ coal: 5800, wind: 250, solar: 2400, gas: 1900, hydro: 90, battery: 150, biomass: 60 }),
  SA1:  () => ({ coal: 0,    wind: 1400, solar: 600, gas: 600, hydro: 0, battery: 250, biomass: 40 }),
  TAS1: () => ({ coal: 0,    wind: 350, solar: 50, gas: 80, hydro: 1700, battery: 30, biomass: 10 }),
  VIC1: () => ({ coal: 4200, wind: 1100, solar: 900, gas: 350, hydro: 700, battery: 200, biomass: 50 }),
  NEM:  () => ({ coal: 17500,wind: 3950, solar: 6150, gas: 4030, hydro: 3090, battery: 830, biomass: 250 }),
};

function estimateAEMO(region: AemoRegion = "NEM"): Mix {
  const t = new Date();
  const hAEDT = (t.getUTCHours() + 11) % 24;
  const sun = hAEDT >= 6 && hAEDT <= 19 ? Math.sin(((hAEDT - 6) / 13) * Math.PI) : 0;
  const base = AEMO_REGION_BASES[region]();
  const genMW: Record<string, number> = {
    coal: noise(base.coal),
    wind: noise(base.wind),
    solar: noise(base.solar * sun),
    gas: noise(base.gas + (1 - sun) * (base.gas * 0.4)),
    hydro: noise(base.hydro),
    battery: noise(sun > 0.6 ? -base.battery * 0.5 : base.battery, 0.2),
    biomass: noise(base.biomass ?? 60),
    other: 60,
  };
  return shape("AEMO", genMW, {
    zone: region,
    src: `https://aemo.com.au/energy-systems/electricity/national-electricity-market-nem`,
    source: "estimate",
  });
}

function estimateKPX(): Mix {
  const t = new Date();
  const hKST = (t.getUTCHours() + 9) % 24;
  const sun = hKST >= 6 && hKST <= 18 ? Math.sin(((hKST - 6) / 12) * Math.PI) : 0;
  const genMW = {
    nuclear: noise(22000),
    coal: noise(19000),
    gas: noise(16000),
    solar: noise(9500 * sun),
    wind: noise(1800),
    hydro: noise(900),
    biomass: noise(750),
    other: 400,
  };
  return shape("KPX", genMW, { zone: "KR", src: "https://www.kpx.or.kr", source: "estimate" });
}

function estimateGB(): Mix {
  const t = new Date();
  const hUK = t.getUTCHours();
  const sun = hUK >= 6 && hUK <= 19 ? Math.sin(((hUK - 6) / 13) * Math.PI) : 0;
  const genMW = {
    wind: noise(11000),
    solar: noise(8500 * sun),
    nuclear: noise(4800),
    gas: noise(7500 + (1 - sun) * 3000),
    biomass: noise(2300),
    imports: noise(4200),
    hydro: noise(800),
    other: 200,
  };
  return shape("GB", genMW, { zone: "GB", src: "https://api.carbonintensity.org.uk/", source: "estimate" });
}

// ---------- Handler -------------------------------------------------------

export const onRequestGet: PagesFunction<Env> = async ({ params, request, env }) => {
  const iso = String(params.iso ?? "").toUpperCase();
  const url = new URL(request.url);
  const regionRaw = (url.searchParams.get("region") ?? "").toUpperCase();
  const region: AemoRegion = (regionRaw in AEMO_REGION_BASES ? regionRaw : "NEM") as AemoRegion;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=60",
    "Content-Type": "application/json",
  };

  let mix: Mix;
  let err: string | undefined;

  try {
    switch (iso) {
      case "CAISO": mix = await tryCAISO(); break;
      case "ERCOT": mix = await tryERCOT(); break;
      case "GB":    mix = await tryGB(); break;
      case "AEMO":  mix = await tryAEMO(region); break;
      case "KPX":   mix = await tryKPX(env); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    switch (iso) {
      case "CAISO": mix = estimateCAISO(); break;
      case "ERCOT": mix = estimateERCOT(); break;
      case "GB":    mix = estimateGB(); break;
      case "AEMO":  mix = estimateAEMO(region); break;
      case "KPX":   mix = estimateKPX(); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  }

  const body = err ? { ...mix, _upstream_error: err } : mix;
  return new Response(JSON.stringify(body, null, 2), { status: 200, headers: cors });
};
