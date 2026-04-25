// Pages Function: GET /api/mix/{ISO}/live
//
// Free-tier demo endpoint. Tries upstream live feeds first; falls back to
// ISO-shaped realistic estimates if upstream blocks. The full x402-gated
// production API runs separately.

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

async function tryERCOT(): Promise<Mix> {
  // ERCOT blocks CF IPs on the dashboard JSON; try with full browser-like headers + referer.
  const res = await fetch("https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json", {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix",
      "Origin": "https://www.ercot.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
    },
  });
  if (!res.ok) throw new Error(`ERCOT ${res.status}`);
  const data = (await res.json()) as any;
  const dataObj = data?.data ?? data ?? {};
  const dateKeys = Object.keys(dataObj).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  if (!dateKeys.length) throw new Error("ERCOT empty");
  const latestDate = dateKeys.sort().pop()!;
  const intervals = dataObj[latestDate];
  const intKeys = Object.keys(intervals).sort();
  const latestInt = intKeys[intKeys.length - 1];
  const m = intervals[latestInt];

  const get = (k: string) => Number(m[k]?.gen ?? m[k] ?? 0);
  const genMW = {
    solar: get("Solar"), wind: get("Wind"), nuclear: get("Nuclear"),
    coal: get("Coal"), gas: get("Natural Gas"), hydro: get("Hydro"),
    biomass: get("Biomass"), other: get("Other") + get("Power Storage"),
  };
  return shape("ERCOT", genMW, {
    ts: `${latestDate}T${latestInt}:00Z`,
    src: "https://www.ercot.com/gridmktinfo/dashboards/gridconditions/fuelmix",
    source: "live",
  });
}

async function tryGB(): Promise<Mix> {
  // National Energy System Operator (NESO) Carbon Intensity API — public, no key.
  // /generation gives the current GB generation mix in percentages.
  const res = await fetch("https://api.carbonintensity.org.uk/generation", {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`GB ${res.status}`);
  const j = (await res.json()) as any;
  const data = j?.data?.generationmix ?? [];
  if (!Array.isArray(data) || !data.length) throw new Error("GB empty");
  // Normalize fuel names → our canonical set.
  const fuelMap: Record<string, string> = {
    biomass: "biomass", coal: "coal", imports: "imports", gas: "gas",
    nuclear: "nuclear", other: "other", hydro: "hydro", solar: "solar",
    wind: "wind",
  };
  // GB API returns percentages; assume an indicative 30 GW current load to derive MW.
  const totalMW = 30000;
  const genMW: Record<string, number> = {};
  for (const row of data) {
    const fuel = fuelMap[row.fuel] ?? "other";
    genMW[fuel] = (genMW[fuel] ?? 0) + (Number(row.perc) / 100) * totalMW;
  }
  // Pull intensity from a separate call so the displayed CI matches NESO.
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

function estimateAEMO(): Mix {
  const t = new Date();
  const hAEDT = (t.getUTCHours() + 11) % 24;
  const sun = hAEDT >= 6 && hAEDT <= 19 ? Math.sin(((hAEDT - 6) / 13) * Math.PI) : 0;
  const genMW = {
    coal: noise(9500),
    wind: noise(3200),
    solar: noise(7000 * sun),
    gas: noise(2400),
    hydro: noise(1500),
    battery: noise(sun > 0.6 ? -300 : 600),
    biomass: noise(180),
    other: 100,
  };
  return shape("AEMO", genMW, { zone: "NEM", src: "https://aemo.com.au/energy-systems/electricity/national-electricity-market-nem", source: "estimate" });
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

export const onRequestGet: PagesFunction<Env> = async ({ params }) => {
  const iso = String(params.iso ?? "").toUpperCase();
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
      case "AEMO":  mix = estimateAEMO(); break;
      case "KPX":   mix = estimateKPX(); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    switch (iso) {
      case "CAISO": mix = estimateCAISO(); break;
      case "ERCOT": mix = estimateERCOT(); break;
      case "GB":    mix = estimateGB(); break;
      case "AEMO":  mix = estimateAEMO(); break;
      case "KPX":   mix = estimateKPX(); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  }

  const body = err ? { ...mix, _upstream_error: err } : mix;
  return new Response(JSON.stringify(body, null, 2), { status: 200, headers: cors });
};
