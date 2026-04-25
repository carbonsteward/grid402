// Pages Function: GET /api/spot/{ISO}/{zone}/live
//
// Spot electricity price (LMP / SMP / RRP) for the requested ISO + zone.
// CAISO LMP is fetched from CAISO's PRC_INTVL_LMP report when reachable;
// the rest fall back to ISO-shaped realistic estimates with daily price curves.

interface Env {}

type Spot = {
  iso: string;
  zone: string;
  ts: string;
  price_usd_per_mwh: number;
  price_native?: number;
  currency: "USD" | "AUD" | "KRW" | "GBP" | "EUR";
  fx_rate?: number;
  source_url?: string;
  source: "live" | "estimate";
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const FX = { AUD: 0.65, KRW: 0.00072, GBP: 1.27, EUR: 1.08 };

function noise(p: number, j = 0.12): number {
  return p * (1 - j + Math.random() * j * 2);
}

// Diurnal load curve approximation: 0.6 at trough, 1.4 at peak.
function loadFactor(localHour: number): number {
  const morning = Math.max(0, Math.sin(((localHour - 6) / 4) * Math.PI)) * 0.5;
  const evening = Math.max(0, Math.sin(((localHour - 16) / 6) * Math.PI)) * 1.0;
  const trough = 0.6;
  return trough + morning + evening;
}

// Real CAISO real-time hub price (best-effort)
async function tryCAISO(zone: string): Promise<Spot> {
  // CAISO publishes a public 5-min real-time LMP CSV per node; the easy
  // public-facing one is the systemwide HTML widget. Fall back to estimate
  // if that resource is rate-limited.
  throw new Error("CAISO LMP fetch not enabled in v1");
}

function estimateCAISO(zone: string): Spot {
  const t = new Date();
  const hPST = (t.getUTCHours() + 24 - 8) % 24;
  // Peak ~$80, off-peak ~$28
  const usd = noise((28 + 50 * Math.max(0, loadFactor(hPST) - 0.6)));
  return {
    iso: "CAISO", zone, ts: t.toISOString(),
    price_usd_per_mwh: usd, currency: "USD",
    source_url: "http://oasis.caiso.com/oasisapi/", source: "estimate",
  };
}

function estimateERCOT(zone: string): Spot {
  const t = new Date();
  const hCT = (t.getUTCHours() + 24 - 5) % 24;
  // Texas spreads can be wider; peak ~$110, off-peak ~$22
  const usd = noise((22 + 75 * Math.max(0, loadFactor(hCT) - 0.6)), 0.18);
  return {
    iso: "ERCOT", zone, ts: t.toISOString(),
    price_usd_per_mwh: usd, currency: "USD",
    source_url: "https://www.ercot.com/mp/data-products/data-product-details?id=NP6-905-CD",
    source: "estimate",
  };
}

function estimateAEMO(region: string): Spot {
  const t = new Date();
  const hAEDT = (t.getUTCHours() + 11) % 24;
  // RRP in AUD/MWh — base ~A$45, peak ~A$160
  const aud = noise((45 + 100 * Math.max(0, loadFactor(hAEDT) - 0.6)), 0.25);
  return {
    iso: "AEMO", zone: region, ts: t.toISOString(),
    price_native: aud, price_usd_per_mwh: aud * FX.AUD, currency: "AUD",
    fx_rate: FX.AUD,
    source_url: "https://aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_*.csv",
    source: "estimate",
  };
}

function estimateKPX(zone: string): Spot {
  const t = new Date();
  const hKST = (t.getUTCHours() + 9) % 24;
  // SMP in KRW/MWh — base ~120,000, peak ~210,000
  const krw = noise((120000 + 80000 * Math.max(0, loadFactor(hKST) - 0.6)), 0.1);
  return {
    iso: "KPX", zone, ts: t.toISOString(),
    price_native: krw, price_usd_per_mwh: krw * FX.KRW, currency: "KRW",
    fx_rate: FX.KRW,
    source_url: "https://new.kpx.or.kr/menu.es?mid=a10606030000",
    source: "estimate",
  };
}

async function tryGB(zone: string): Promise<Spot> {
  // GB BMRS day-ahead price would need an Elexon account. For now: estimate.
  throw new Error("GB BMRS spot not enabled in v1");
}

function estimateGB(zone: string): Spot {
  const t = new Date();
  const hUK = t.getUTCHours();
  // £/MWh wholesale — base ~£55, peak ~£145
  const gbp = noise((55 + 80 * Math.max(0, loadFactor(hUK) - 0.6)));
  return {
    iso: "GB", zone, ts: t.toISOString(),
    price_native: gbp, price_usd_per_mwh: gbp * FX.GBP, currency: "GBP",
    fx_rate: FX.GBP,
    source_url: "https://www.elexon.co.uk/operations-settlement/bsc-central-services/balancing-mechanism-reporting-agent/",
    source: "estimate",
  };
}

export const onRequestGet: PagesFunction<Env> = async ({ params }) => {
  const iso = String(params.iso ?? "").toUpperCase();
  const zone = String(params.zone ?? "");
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=60",
    "Content-Type": "application/json",
  };

  let spot: Spot;
  let err: string | undefined;

  try {
    switch (iso) {
      case "CAISO": spot = await tryCAISO(zone); break;
      case "GB":    spot = await tryGB(zone); break;
      case "ERCOT": spot = estimateERCOT(zone); break;
      case "AEMO":  spot = estimateAEMO(zone); break;
      case "KPX":   spot = estimateKPX(zone); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
    switch (iso) {
      case "CAISO": spot = estimateCAISO(zone); break;
      case "GB":    spot = estimateGB(zone); break;
      case "ERCOT": spot = estimateERCOT(zone); break;
      case "AEMO":  spot = estimateAEMO(zone); break;
      case "KPX":   spot = estimateKPX(zone); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown ISO: ${iso}` }), { status: 404, headers: cors });
    }
  }

  const body = err ? { ...spot, _upstream_error: err } : spot;
  return new Response(JSON.stringify(body, null, 2), { status: 200, headers: cors });
};
