// Grid402 API — pay-per-call electricity market data for AI agents.
//
// Architecture:
//   Hono HTTP server, gated by `@x402/hono` payment middleware.
//   Every paid request = one USDC payment on Base (or Base Sepolia for tests),
//   settled through an x402 facilitator. Responses are public-domain ISO data.
//
// MVP endpoints (all CAISO; ERCOT / ENTSO-E follow the same pattern):
//   GET  /                                    free metadata
//   GET  /spot/CAISO/:zone/live               $0.005  — 5-min LMP, USD/MWh
//   GET  /mix/CAISO/live                      $0.005  — system-wide fuel mix
//   GET  /emissions/CAISO/live                $0.010  — self-computed gCO2/kWh
//   GET  /combined/CAISO/:zone/live           $0.015  — price + mix + emissions
//
// Adding another ISO = new `src/<iso>.ts` + new routes here.

import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

import {
  getCaisoLivePriceCached,
  getCaisoMixCached,
} from "./caiso.js";
import { getKpxPriceCached, getKpxMixCached } from "./kpx.js";
import { getErcotPriceCached, getErcotMixCached } from "./ercot.js";
import { getAemoPriceCached, getAemoMixCached } from "./aemo.js";
import { computeEmissions } from "./emission-factors.js";
import type {
  CombinedResponse,
  EmissionsOnly,
  MixOnly,
  PriceOnly,
} from "./types.js";

config();

const PORT = Number(process.env.PORT ?? 3402);
const EVM_ADDRESS = process.env.EVM_ADDRESS as `0x${string}` | undefined;
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const PAYMENT_NETWORK = (process.env.PAYMENT_NETWORK ?? "eip155:84532") as `${string}:${string}`;

if (!EVM_ADDRESS) {
  console.error("❌ EVM_ADDRESS is required (set in .env)");
  process.exit(1);
}
if (!FACILITATOR_URL) {
  console.error("❌ FACILITATOR_URL is required (set in .env)");
  process.exit(1);
}

const app = new Hono();

// ----- Payment gate ---------------------------------------------------------

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const priceTerms    = { scheme: "exact" as const, price: "$0.005", network: PAYMENT_NETWORK, payTo: EVM_ADDRESS };
const mixTerms      = { scheme: "exact" as const, price: "$0.005", network: PAYMENT_NETWORK, payTo: EVM_ADDRESS };
const emissionsTerms = { scheme: "exact" as const, price: "$0.010", network: PAYMENT_NETWORK, payTo: EVM_ADDRESS };
const combinedTerms = { scheme: "exact" as const, price: "$0.015", network: PAYMENT_NETWORK, payTo: EVM_ADDRESS };

app.use(
  paymentMiddleware(
    {
      "GET /spot/CAISO/:zone/live": {
        accepts: [priceTerms],
        description: "Latest 5-minute LMP for a CAISO pricing node, in USD/MWh.",
        mimeType: "application/json",
      },
      "GET /mix/CAISO/live": {
        accepts: [mixTerms],
        description: "Latest 5-minute system-wide generation mix for CAISO, MW by fuel.",
        mimeType: "application/json",
      },
      "GET /emissions/CAISO/live": {
        accepts: [emissionsTerms],
        description: "Self-computed grid emission intensity (gCO2/kWh) for CAISO, plus share %.",
        mimeType: "application/json",
      },
      "GET /combined/CAISO/:zone/live": {
        accepts: [combinedTerms],
        description: "Unified price + mix + emissions snapshot for a CAISO zone.",
        mimeType: "application/json",
      },
      "GET /spot/KPX/:zone/live": {
        accepts: [priceTerms],
        description: "Latest hourly Korea SMP (KPX 육지), USD/MWh (KRW→USD via KRW_USD_RATE).",
        mimeType: "application/json",
      },
      "GET /mix/KPX/live": {
        accepts: [mixTerms],
        description: "Latest 5-min Korea generation mix from KPX OpenAPI sumperfuel5m (hourly HTML fallback).",
        mimeType: "application/json",
      },
      "GET /emissions/KPX/live": {
        accepts: [emissionsTerms],
        description: "Self-computed Korea grid emission intensity (gCO2/kWh) from KPX 5-min mix.",
        mimeType: "application/json",
      },
      "GET /combined/KPX/:zone/live": {
        accepts: [combinedTerms],
        description: "Unified Korea price + mix + emissions snapshot (KPX 육지).",
        mimeType: "application/json",
      },
      "GET /spot/ERCOT/:hub/live": {
        accepts: [priceTerms],
        description: "Latest 15-minute RTM Settlement Point Price for an ERCOT hub or load zone, USD/MWh.",
        mimeType: "application/json",
      },
      "GET /mix/ERCOT/live": {
        accepts: [mixTerms],
        description: "Latest 5-minute system-wide ERCOT generation mix, MW by fuel (8 fuels).",
        mimeType: "application/json",
      },
      "GET /emissions/ERCOT/live": {
        accepts: [emissionsTerms],
        description: "Self-computed ERCOT grid emission intensity (gCO2/kWh) plus share %.",
        mimeType: "application/json",
      },
      "GET /combined/ERCOT/:hub/live": {
        accepts: [combinedTerms],
        description: "Unified price + mix + emissions snapshot for an ERCOT hub.",
        mimeType: "application/json",
      },
      "GET /spot/AEMO/:region/live": {
        accepts: [priceTerms],
        description: "Latest 5-minute AEMO regional reference price (NSW1/QLD1/VIC1/SA1/TAS1), USD/MWh.",
        mimeType: "application/json",
      },
      "GET /mix/AEMO/:region/live": {
        accepts: [mixTerms],
        description: "Latest 5-minute AEMO generation mix per region, aggregated from DUID-level SCADA via OpenNEM registry.",
        mimeType: "application/json",
      },
      "GET /emissions/AEMO/:region/live": {
        accepts: [emissionsTerms],
        description: "Self-computed AEMO regional emission intensity (gCO2/kWh).",
        mimeType: "application/json",
      },
      "GET /combined/AEMO/:region/live": {
        accepts: [combinedTerms],
        description: "Unified AEMO regional price + mix + emissions snapshot.",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(
      PAYMENT_NETWORK,
      new ExactEvmScheme(),
    ),
  ),
);

// ----- Free endpoints -------------------------------------------------------

app.get("/", c =>
  c.json({
    name: "Grid402",
    description:
      "Pay-per-call electricity market data for AI agents. Gated by x402 on Base.",
    endpoints: [
      // CAISO (5-min mix)
      { path: "/spot/CAISO/:zone/live",     method: "GET", priceUsd: 0.005, sample: "/spot/CAISO/TH_NP15_GEN-APND/live" },
      { path: "/mix/CAISO/live",            method: "GET", priceUsd: 0.005, sample: "/mix/CAISO/live" },
      { path: "/emissions/CAISO/live",      method: "GET", priceUsd: 0.010, sample: "/emissions/CAISO/live" },
      { path: "/combined/CAISO/:zone/live", method: "GET", priceUsd: 0.015, sample: "/combined/CAISO/TH_NP15_GEN-APND/live" },
      // KPX (Korea, 5-min mix via OpenAPI; hourly fallback)
      { path: "/spot/KPX/:zone/live",       method: "GET", priceUsd: 0.005, sample: "/spot/KPX/KR/live" },
      { path: "/mix/KPX/live",              method: "GET", priceUsd: 0.005, sample: "/mix/KPX/live" },
      { path: "/emissions/KPX/live",        method: "GET", priceUsd: 0.010, sample: "/emissions/KPX/live" },
      { path: "/combined/KPX/:zone/live",   method: "GET", priceUsd: 0.015, sample: "/combined/KPX/KR/live" },
      // ERCOT (Texas, 5-min mix via proxy)
      { path: "/spot/ERCOT/:hub/live",      method: "GET", priceUsd: 0.005, sample: "/spot/ERCOT/HB_NORTH/live" },
      { path: "/mix/ERCOT/live",            method: "GET", priceUsd: 0.005, sample: "/mix/ERCOT/live" },
      { path: "/emissions/ERCOT/live",      method: "GET", priceUsd: 0.010, sample: "/emissions/ERCOT/live" },
      { path: "/combined/ERCOT/:hub/live",  method: "GET", priceUsd: 0.015, sample: "/combined/ERCOT/HB_NORTH/live" },
      // AEMO (Australia, 5-min DUID-level mix → fuel aggregation)
      { path: "/spot/AEMO/:region/live",     method: "GET", priceUsd: 0.005, sample: "/spot/AEMO/NSW1/live" },
      { path: "/mix/AEMO/:region/live",      method: "GET", priceUsd: 0.005, sample: "/mix/AEMO/NSW1/live" },
      { path: "/emissions/AEMO/:region/live", method: "GET", priceUsd: 0.010, sample: "/emissions/AEMO/NSW1/live" },
      { path: "/combined/AEMO/:region/live", method: "GET", priceUsd: 0.015, sample: "/combined/AEMO/NSW1/live" },
    ],
    settlement: {
      protocol: "x402",
      network:  PAYMENT_NETWORK,
      asset:    "USDC",
      payTo:    EVM_ADDRESS,
    },
    docs: "https://github.com/<you>/grid402",
  }),
);

// ----- Paid: price ---------------------------------------------------------

app.get("/spot/CAISO/:zone/live", async c => {
  const zone = c.req.param("zone");
  try {
    const tick = await getCaisoLivePriceCached(zone);
    const body: PriceOnly = {
      iso: "CAISO",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        price: { lmp_usd_per_mwh: tick.lmpUsdPerMwh, market: tick.market },
      },
      source: caisoOasisSource(tick.ts),
    };
    return c.json(body);
  } catch (err) {
    return c.json(upstreamError(err), 502);
  }
});

// ----- Paid: generation mix ------------------------------------------------

app.get("/mix/CAISO/live", async c => {
  try {
    const tick = await getCaisoMixCached();
    const body: MixOnly = {
      iso: "CAISO",
      zone: "CAISO",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        generation_mix: { mw: tick.mw, total_mw: tick.totalMw },
      },
      source: caisoFuelsourceSource(tick.ts),
    };
    return c.json(body);
  } catch (err) {
    return c.json(upstreamError(err), 502);
  }
});

// ----- Paid: emissions (self-computed from mix) ----------------------------

app.get("/emissions/CAISO/live", async c => {
  try {
    const tick = await getCaisoMixCached();
    const emissions = computeEmissions(tick.mw, "IPCC_AR6_lifecycle");
    const body: EmissionsOnly = {
      iso: "CAISO",
      zone: "CAISO",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        generation_mix: { mw: tick.mw, total_mw: tick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: caisoFuelsourceSource(tick.ts),
    };
    return c.json(body);
  } catch (err) {
    return c.json(upstreamError(err), 502);
  }
});

// ----- Paid: combined response (the killer feature) ------------------------

app.get("/combined/CAISO/:zone/live", async c => {
  const zone = c.req.param("zone");
  try {
    // Fetch price and mix in parallel — they hit different CAISO endpoints.
    const [priceTick, mixTick] = await Promise.all([
      getCaisoLivePriceCached(zone),
      getCaisoMixCached(),
    ]);
    const emissions = computeEmissions(mixTick.mw, "IPCC_AR6_lifecycle");

    // Use the price interval as the authoritative one; mix interval may lag.
    const body: CombinedResponse = {
      iso: "CAISO",
      zone: priceTick.zone,
      interval_start_utc: priceTick.intervalStartUtc,
      interval_end_utc:   priceTick.intervalEndUtc,
      signals: {
        price: {
          lmp_usd_per_mwh: priceTick.lmpUsdPerMwh,
          market: priceTick.market,
        },
        generation_mix: { mw: mixTick.mw, total_mw: mixTick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: caisoCombinedSource(priceTick.ts),
    };
    return c.json(body);
  } catch (err) {
    return c.json(upstreamError(err), 502);
  }
});

// ============================================================================
// KPX (Korea) — price + mix + emissions + combined
// ============================================================================

app.get("/spot/KPX/:zone/live", async c => {
  const zone = c.req.param("zone");
  try {
    const tick = await getKpxPriceCached(zone);
    const body: PriceOnly = {
      iso: "KPX",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { price: { lmp_usd_per_mwh: tick.lmpUsdPerMwh, market: tick.market } },
      source: kpxSmpSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/mix/KPX/live", async c => {
  try {
    const tick = await getKpxMixCached();
    const body: MixOnly = {
      iso: "KPX",
      zone: "KR",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { generation_mix: { mw: tick.mw, total_mw: tick.totalMw } },
      source: kpxMixSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/emissions/KPX/live", async c => {
  try {
    const tick = await getKpxMixCached();
    const emissions = computeEmissions(tick.mw, "IPCC_AR6_lifecycle");
    const body: EmissionsOnly = {
      iso: "KPX",
      zone: "KR",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        generation_mix: { mw: tick.mw, total_mw: tick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: kpxMixSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/combined/KPX/:zone/live", async c => {
  const zone = c.req.param("zone");
  try {
    const [priceTick, mixTick] = await Promise.all([
      getKpxPriceCached(zone),
      getKpxMixCached(),
    ]);
    const emissions = computeEmissions(mixTick.mw, "IPCC_AR6_lifecycle");
    const body: CombinedResponse = {
      iso: "KPX",
      zone: priceTick.zone,
      interval_start_utc: priceTick.intervalStartUtc,
      interval_end_utc:   priceTick.intervalEndUtc,
      signals: {
        price: { lmp_usd_per_mwh: priceTick.lmpUsdPerMwh, market: priceTick.market },
        generation_mix: { mw: mixTick.mw, total_mw: mixTick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: kpxCombinedSource(priceTick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

// ============================================================================
// ERCOT (Texas) — price + mix + emissions + combined
// ============================================================================

app.get("/spot/ERCOT/:hub/live", async c => {
  const hub = c.req.param("hub") || "HB_HUBAVG";
  try {
    const tick = await getErcotPriceCached(hub);
    const body: PriceOnly = {
      iso: "ERCOT",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { price: { lmp_usd_per_mwh: tick.lmpUsdPerMwh, market: tick.market } },
      source: ercotPriceSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/mix/ERCOT/live", async c => {
  try {
    const tick = await getErcotMixCached();
    const body: MixOnly = {
      iso: "ERCOT",
      zone: "ERCOT",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { generation_mix: { mw: tick.mw, total_mw: tick.totalMw } },
      source: ercotMixSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/emissions/ERCOT/live", async c => {
  try {
    const tick = await getErcotMixCached();
    const emissions = computeEmissions(tick.mw, "IPCC_AR6_lifecycle");
    const body: EmissionsOnly = {
      iso: "ERCOT",
      zone: "ERCOT",
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        generation_mix: { mw: tick.mw, total_mw: tick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: ercotMixSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/combined/ERCOT/:hub/live", async c => {
  const hub = c.req.param("hub") || "HB_HUBAVG";
  try {
    const [priceTick, mixTick] = await Promise.all([
      getErcotPriceCached(hub),
      getErcotMixCached(),
    ]);
    const emissions = computeEmissions(mixTick.mw, "IPCC_AR6_lifecycle");
    const body: CombinedResponse = {
      iso: "ERCOT",
      zone: priceTick.zone,
      interval_start_utc: priceTick.intervalStartUtc,
      interval_end_utc:   priceTick.intervalEndUtc,
      signals: {
        price: { lmp_usd_per_mwh: priceTick.lmpUsdPerMwh, market: priceTick.market },
        generation_mix: { mw: mixTick.mw, total_mw: mixTick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: ercotCombinedSource(priceTick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

// ============================================================================
// AEMO (Australia) — 5 regions: NSW1 / QLD1 / VIC1 / SA1 / TAS1
// ============================================================================

app.get("/spot/AEMO/:region/live", async c => {
  const region = c.req.param("region").toUpperCase();
  try {
    const tick = await getAemoPriceCached(region);
    const body: PriceOnly = {
      iso: "AEMO",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { price: { lmp_usd_per_mwh: tick.lmpUsdPerMwh, market: tick.market } },
      source: aemoSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/mix/AEMO/:region/live", async c => {
  const region = c.req.param("region").toUpperCase();
  try {
    const tick = await getAemoMixCached(region);
    const body: MixOnly = {
      iso: "AEMO",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: { generation_mix: { mw: tick.mw, total_mw: tick.totalMw } },
      source: aemoSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/emissions/AEMO/:region/live", async c => {
  const region = c.req.param("region").toUpperCase();
  try {
    const tick = await getAemoMixCached(region);
    const emissions = computeEmissions(tick.mw, "IPCC_AR6_lifecycle");
    const body: EmissionsOnly = {
      iso: "AEMO",
      zone: tick.zone,
      interval_start_utc: tick.intervalStartUtc,
      interval_end_utc:   tick.intervalEndUtc,
      signals: {
        generation_mix: { mw: tick.mw, total_mw: tick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: aemoSource(tick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

app.get("/combined/AEMO/:region/live", async c => {
  const region = c.req.param("region").toUpperCase();
  try {
    const [priceTick, mixTick] = await Promise.all([
      getAemoPriceCached(region),
      getAemoMixCached(region),
    ]);
    const emissions = computeEmissions(mixTick.mw, "IPCC_AR6_lifecycle");
    const body: CombinedResponse = {
      iso: "AEMO",
      zone: priceTick.zone,
      interval_start_utc: priceTick.intervalStartUtc,
      interval_end_utc:   priceTick.intervalEndUtc,
      signals: {
        price: { lmp_usd_per_mwh: priceTick.lmpUsdPerMwh, market: priceTick.market },
        generation_mix: { mw: mixTick.mw, total_mw: mixTick.totalMw },
        emissions: {
          method:                   emissions.method,
          gco2_per_kwh:             emissions.gco2_per_kwh,
          fossil_only_gco2_per_kwh: emissions.fossil_only_gco2_per_kwh,
          factor_source:            emissions.factor_source,
          self_computed:            true,
        },
        shares: emissions.shares,
      },
      source: aemoSource(priceTick.ts),
    };
    return c.json(body);
  } catch (err) { return c.json(upstreamError(err), 502); }
});

// ----- Helpers --------------------------------------------------------------

function caisoOasisSource(fetchedAt: string) {
  return {
    publisher: "California ISO (CAISO) OASIS",
    license:   "US public domain",
    upstream:  "https://oasis.caiso.com/oasisapi/SingleZip",
    fetched_at: fetchedAt,
  };
}
function caisoFuelsourceSource(fetchedAt: string) {
  return {
    publisher: "California ISO (CAISO) Outlook",
    license:   "US public domain",
    upstream:  "https://www.caiso.com/outlook/current/fuelsource.csv",
    fetched_at: fetchedAt,
  };
}
function caisoCombinedSource(fetchedAt: string) {
  return {
    publisher: "California ISO (CAISO) — OASIS + Outlook",
    license:   "US public domain",
    upstream:  "oasis.caiso.com + www.caiso.com/outlook",
    fetched_at: fetchedAt,
  };
}
function kpxSmpSource(fetchedAt: string) {
  return {
    publisher: "한국전력거래소(KPX) — new.kpx.or.kr 육지 SMP",
    license:   "공공누리 제1유형 (KOGL Type 1)",
    upstream:  "https://new.kpx.or.kr/smpInland.es",
    fetched_at: fetchedAt,
  };
}
function kpxMixSource(fetchedAt: string) {
  return {
    publisher: "한국전력거래소(KPX) via data.go.kr OpenAPI",
    license:   "공공누리 제1유형 (KOGL Type 1)",
    upstream:  "https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m",
    fetched_at: fetchedAt,
  };
}
function kpxCombinedSource(fetchedAt: string) {
  return {
    publisher: "한국전력거래소(KPX) — SMP HTML + sumperfuel5m OpenAPI",
    license:   "공공누리 제1유형 (KOGL Type 1)",
    upstream:  "new.kpx.or.kr + openapi.kpx.or.kr",
    fetched_at: fetchedAt,
  };
}
function ercotPriceSource(fetchedAt: string) {
  return {
    publisher: "Electric Reliability Council of Texas (ERCOT) Public Dashboards",
    license:   "US public domain (Texas open data)",
    upstream:  "ercot.com/api/1/services/read/dashboards/systemWidePrices.json (via proxy)",
    fetched_at: fetchedAt,
  };
}
function ercotMixSource(fetchedAt: string) {
  return {
    publisher: "Electric Reliability Council of Texas (ERCOT) Public Dashboards",
    license:   "US public domain (Texas open data)",
    upstream:  "ercot.com/api/1/services/read/dashboards/fuel-mix.json (via proxy)",
    fetched_at: fetchedAt,
  };
}
function ercotCombinedSource(fetchedAt: string) {
  return {
    publisher: "ERCOT Public Dashboards (systemWidePrices + fuel-mix)",
    license:   "US public domain (Texas open data)",
    upstream:  "ercot.com/api/1/services/read/dashboards (via proxy)",
    fetched_at: fetchedAt,
  };
}
function aemoSource(fetchedAt: string) {
  return {
    publisher: "Australian Energy Market Operator (AEMO) — NEMWEB",
    license:   "Public Australian Government Data (free use, attribution recommended)",
    upstream:  "nemweb.com.au/Reports/Current/{DispatchIS_Reports,Dispatch_SCADA}",
    fetched_at: fetchedAt,
  };
}
function upstreamError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { error: `Upstream: ${msg}` };
}

// ----- Boot -----------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, info => {
  console.log(`⚡ Grid402 API listening on http://localhost:${info.port}`);
  console.log(`   Network: ${PAYMENT_NETWORK}`);
  console.log(`   PayTo:   ${EVM_ADDRESS}`);
  console.log(`   Facil:   ${FACILITATOR_URL}`);
  console.log(``);
  console.log(`   Try: curl http://localhost:${info.port}/`);
});
