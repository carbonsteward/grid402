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
      { path: "/spot/CAISO/:zone/live",     method: "GET", priceUsd: 0.005,
        description: "Latest 5-min LMP for a CAISO pricing node.",
        sample:     "/spot/CAISO/TH_NP15_GEN-APND/live" },
      { path: "/mix/CAISO/live",            method: "GET", priceUsd: 0.005,
        description: "System-wide 5-min generation mix for CAISO, MW by fuel.",
        sample:     "/mix/CAISO/live" },
      { path: "/emissions/CAISO/live",      method: "GET", priceUsd: 0.010,
        description: "Self-computed CAISO grid emission intensity + share %.",
        sample:     "/emissions/CAISO/live" },
      { path: "/combined/CAISO/:zone/live", method: "GET", priceUsd: 0.015,
        description: "Unified price + mix + emissions for a CAISO zone.",
        sample:     "/combined/CAISO/TH_NP15_GEN-APND/live" },
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
