// Pages Function: GET /api/mix/{ISO}/history?hours=24&step=30
//
// Returns a time-series of mix snapshots over the requested window. Used by
// the time slider on the live map.
//
// Live history coverage:
//   CAISO  — 5-min CSV from caiso.com (today's intervals)
//   GB     — NESO Carbon Intensity API /intensity + /generation
//   ERCOT  — fuel-mix.json (Electricity Maps proxy) returns ALL today's 5-min
//            intervals, so we walk the dataObj across all date keys & build
//            history directly.
//   AEMO   — would require fetching N×288 ZIPs from NEMWEB (expensive); we
//            return the latest live snapshot replicated and let the estimate
//            time-curve fill the rest. Kept as deterministic estimate for now.
//   KPX    — data.go.kr key still returns 403; estimate.

interface Env {}

type Snapshot = {
  ts: string;
  ci_g_per_kwh: number;
  generation_mw: Record<string, number>;
  pct: Record<string, number>;
};

type Series = {
  iso: string;
  zone?: string;
  source: "live" | "estimate";
  step_minutes: number;
  source_url?: string;
  series: Snapshot[];
};

const CI: Record<string, number> = {
  solar: 41, wind: 11, hydro: 24, nuclear: 12, geothermal: 38, biomass: 230,
  battery: 0, imports: 380, oil: 720, coal: 820, gas: 490, other: 400,
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ERCOT_PROXY = "https://us-ca-proxy-jfnx5klx2a-uw.a.run.app";

function pctFromGenMW(gen: Record<string, number>): Record<string, number> {
  const total = Object.values(gen).reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(gen)) out[k] = (Math.max(v, 0) / total) * 100;
  return out;
}

function ciFromMix(gen: Record<string, number>): number {
  const total = Object.values(gen).reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  let w = 0;
  for (const [fuel, mw] of Object.entries(gen)) {
    w += (Math.max(mw, 0) / total) * (CI[fuel] ?? CI.other);
  }
  return w;
}

function seedNoise(t: number, seed: number): number {
  const x = Math.sin(t * 0.0001 + seed) * 43758.5453;
  return (x - Math.floor(x)) - 0.5;
}

function withNoise(p: number, ts: number, seed: number, jitter = 0.08): number {
  return p * (1 + jitter * seedNoise(ts, seed));
}

// ---------- CAISO live (real CSV) ----------------------------------------

async function tryCAISO(stepMin: number, hours: number): Promise<Series> {
  const res = await fetch("https://www.caiso.com/outlook/current/fuelsource.csv", {
    headers: { "User-Agent": UA, "Accept": "text/csv,*/*" },
  });
  if (!res.ok) throw new Error(`CAISO ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map(s => s.trim().toLowerCase());
  const idx = (n: string) => header.indexOf(n);

  const baseDate = new Date().toISOString().slice(0, 10);
  const allRows = lines.slice(1).map(line => {
    const c = line.split(",").map(s => s.trim());
    const time = c[0];
    if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return null;
    const ts = `${baseDate}T${time.padStart(5, "0")}:00Z`;
    const get = (n: string) => Number(c[idx(n)]) || 0;
    const gen = {
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
    return { ts, gen };
  }).filter((x): x is { ts: string; gen: Record<string, number> } => !!x);

  const stride = Math.max(1, Math.round(stepMin / 5));
  const sampled: Snapshot[] = [];
  for (let i = 0; i < allRows.length; i += stride) {
    const r = allRows[i];
    sampled.push({ ts: r.ts, generation_mw: r.gen, pct: pctFromGenMW(r.gen), ci_g_per_kwh: ciFromMix(r.gen) });
  }

  return {
    iso: "CAISO",
    source: "live",
    step_minutes: stepMin,
    source_url: "https://www.caiso.com/TodaysOutlook/Pages/default.aspx",
    series: sampled.slice(-Math.ceil((hours * 60) / stepMin)),
  };
}

// ---------- ERCOT live (fuel-mix.json — ALL 5-min intervals today) -------

async function tryERCOT(stepMin: number, hours: number): Promise<Series> {
  const url = `${ERCOT_PROXY}/api/1/services/read/dashboards/fuel-mix.json?host=https://www.ercot.com`;
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
  const j = JSON.parse(text) as any;
  const dataObj = j?.data ?? {};
  const dateKeys = Object.keys(dataObj).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  if (!dateKeys.length) throw new Error("ERCOT empty");

  // Walk every interval in chronological order across all date keys.
  const allRows: Array<{ ts: string; gen: Record<string, number> }> = [];
  for (const dk of dateKeys) {
    const intervals = dataObj[dk] ?? {};
    for (const intKey of Object.keys(intervals).sort()) {
      const fuels = intervals[intKey] ?? {};
      const tsMs = Date.parse(intKey.replace(" ", "T"));
      if (!Number.isFinite(tsMs)) continue;
      const get = (k: string) => Number(fuels[k]?.gen ?? 0);
      const gen = {
        coal: get("Coal and Lignite"),
        gas: get("Natural Gas"),
        nuclear: get("Nuclear"),
        hydro: get("Hydro"),
        solar: Math.max(get("Solar"), 0),
        wind: get("Wind"),
        battery: get("Power Storage"),
        other: get("Other"),
      };
      allRows.push({ ts: new Date(tsMs).toISOString(), gen });
    }
  }
  if (!allRows.length) throw new Error("ERCOT no rows");

  // ERCOT native step is 5-min. Subsample to requested step.
  const stride = Math.max(1, Math.round(stepMin / 5));
  const sampled: Snapshot[] = [];
  for (let i = 0; i < allRows.length; i += stride) {
    const r = allRows[i];
    sampled.push({ ts: r.ts, generation_mw: r.gen, pct: pctFromGenMW(r.gen), ci_g_per_kwh: ciFromMix(r.gen) });
  }
  return {
    iso: "ERCOT",
    source: "live",
    step_minutes: stepMin,
    source_url: "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix",
    series: sampled.slice(-Math.ceil((hours * 60) / stepMin)),
  };
}

// ---------- GB live (NESO Carbon Intensity API) --------------------------

async function tryGB(hours: number): Promise<Series> {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().split(".")[0] + "Z";
  const url = `https://api.carbonintensity.org.uk/intensity/${fmt(from)}/${fmt(to)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`GB ${res.status}`);
  const j = (await res.json()) as any;
  const rows = (j?.data ?? []) as Array<{ from: string; to: string; intensity: { actual: number | null; forecast: number } }>;

  const url2 = `https://api.carbonintensity.org.uk/generation/${fmt(from)}/${fmt(to)}`;
  let mixRows: any[] = [];
  try {
    const r2 = await fetch(url2, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (r2.ok) mixRows = ((await r2.json()) as any)?.data ?? [];
  } catch {}

  const totalMW = 30000;
  const series: Snapshot[] = rows.map(row => {
    const ci = row.intensity.actual ?? row.intensity.forecast;
    const matched = mixRows.find(m => m.from === row.from);
    const gen: Record<string, number> = {};
    if (matched?.generationmix) {
      for (const m of matched.generationmix) {
        const fuel = String(m.fuel).toLowerCase();
        gen[fuel] = (gen[fuel] ?? 0) + (Number(m.perc) / 100) * totalMW;
      }
    }
    return { ts: row.from, ci_g_per_kwh: ci, generation_mw: gen, pct: pctFromGenMW(gen) };
  });

  return {
    iso: "GB",
    source: "live",
    step_minutes: 30,
    source_url: "https://api.carbonintensity.org.uk/",
    series,
  };
}

// ---------- Synthetic 24h series for ISOs without easy upstream history --

function generateSeries(
  iso: string,
  zone: string | undefined,
  hours: number,
  stepMin: number,
  hourToMix: (hUTC: number, t: number) => Record<string, number>,
  src: string,
): Series {
  const slots = Math.ceil((hours * 60) / stepMin);
  const series: Snapshot[] = [];
  const now = Date.now();
  const aligned = Math.floor(now / (stepMin * 60_000)) * (stepMin * 60_000);
  for (let i = slots - 1; i >= 0; i--) {
    const t = aligned - i * stepMin * 60_000;
    const d = new Date(t);
    const hUTC = d.getUTCHours() + d.getUTCMinutes() / 60;
    const gen = hourToMix(hUTC, t);
    series.push({
      ts: d.toISOString(),
      generation_mw: gen,
      pct: pctFromGenMW(gen),
      ci_g_per_kwh: ciFromMix(gen),
    });
  }
  return { iso, zone, source: "estimate", step_minutes: stepMin, source_url: src, series };
}

function ercotMix(hUTC: number, t: number) {
  const hCT = (hUTC + 24 - 5) % 24;
  const sun = hCT >= 6 && hCT <= 19 ? Math.sin(((hCT - 6) / 13) * Math.PI) : 0;
  return {
    wind: withNoise(15000, t, 1),
    solar: withNoise(18000 * sun, t, 2),
    nuclear: withNoise(5100, t, 3),
    coal: withNoise(8500, t, 4),
    gas: withNoise(20000 + (1 - sun) * 8000, t, 5),
    hydro: withNoise(150, t, 6),
    biomass: withNoise(120, t, 7),
    other: 200,
  };
}

function aemoMix(hUTC: number, t: number) {
  const hAEDT = (hUTC + 11) % 24;
  const sun = hAEDT >= 6 && hAEDT <= 19 ? Math.sin(((hAEDT - 6) / 13) * Math.PI) : 0;
  return {
    coal: withNoise(9500, t, 11),
    wind: withNoise(3200, t, 12),
    solar: withNoise(7000 * sun, t, 13),
    gas: withNoise(2400, t, 14),
    hydro: withNoise(1500, t, 15),
    battery: withNoise(sun > 0.6 ? -300 : 600, t, 16, 0.2),
    biomass: withNoise(180, t, 17),
    other: 100,
  };
}

function kpxMix(hUTC: number, t: number) {
  const hKST = (hUTC + 9) % 24;
  const sun = hKST >= 6 && hKST <= 18 ? Math.sin(((hKST - 6) / 12) * Math.PI) : 0;
  return {
    nuclear: withNoise(22000, t, 21),
    coal: withNoise(19000, t, 22),
    gas: withNoise(16000, t, 23),
    solar: withNoise(9500 * sun, t, 24),
    wind: withNoise(1800, t, 25),
    hydro: withNoise(900, t, 26),
    biomass: withNoise(750, t, 27),
    other: 400,
  };
}

function caisoMixEstimate(hUTC: number, t: number) {
  const hPST = (hUTC + 24 - 8) % 24;
  const sun = hPST >= 6 && hPST <= 18 ? Math.sin(((hPST - 6) / 12) * Math.PI) : 0;
  return {
    solar: withNoise(11000 * sun, t, 31),
    wind: withNoise(2400, t, 32),
    nuclear: withNoise(2240, t, 33),
    hydro: withNoise(1900, t, 34),
    geothermal: withNoise(800, t, 35),
    biomass: withNoise(550, t, 36),
    gas: withNoise(4200 + (1 - sun) * 3500, t, 37),
    imports: withNoise(3200, t, 38),
    battery: withNoise(sun > 0.7 ? -800 : 1200, t, 39, 0.2),
    other: 200,
  };
}

// ---------- Handler -------------------------------------------------------

export const onRequestGet: PagesFunction<Env> = async ({ params, request }) => {
  const iso = String(params.iso ?? "").toUpperCase();
  const url = new URL(request.url);
  const hours = Math.max(1, Math.min(48, Number(url.searchParams.get("hours")) || 24));
  const step = Math.max(5, Math.min(120, Number(url.searchParams.get("step")) || 30));

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  };

  let body: Series;
  let err: string | undefined;

  try {
    switch (iso) {
      case "CAISO": body = await tryCAISO(step, hours); break;
      case "ERCOT": body = await tryERCOT(step, hours); break;
      case "GB":    body = await tryGB(hours); break;
      case "AEMO":  body = generateSeries("AEMO", "NEM", hours, step, aemoMix, "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/"); break;
      case "KPX":   body = generateSeries("KPX", "KR", hours, step, kpxMix, "https://www.kpx.or.kr"); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    if (iso === "CAISO") body = generateSeries("CAISO", undefined, hours, step, caisoMixEstimate, "https://www.caiso.com/TodaysOutlook/Pages/default.aspx");
    else if (iso === "ERCOT") body = generateSeries("ERCOT", undefined, hours, step, ercotMix, "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix");
    else if (iso === "GB") body = generateSeries("GB", "GB", hours, step, () => ({ wind: 11000, gas: 7500, nuclear: 4800, biomass: 2300, imports: 4200, hydro: 800, other: 200 }), "https://api.carbonintensity.org.uk/");
    else throw e;
  }

  const out = err ? { ...body, _upstream_error: err } : body;
  return new Response(JSON.stringify(out, null, 2), { status: 200, headers: cors });
};
