# Grid402

> **Pay-per-call API for the world's electricity market's sub-hourly generation mix and prices, settled in USDC on Base via [x402](https://x402.org).**

The first agent-native data primitive for the grid. CAISO · ERCOT · AEMO · ENTSO-E · KPX, normalized into one schema, gated by HTTP 402.

```bash
$ curl -i https://api.grid402.xyz/spot/CAISO/TH_NP15_GEN-APND/live
HTTP/1.1 402 Payment Required
{ "accepts": [{ "scheme": "exact", "price": "$0.005",
                "network": "eip155:8453", "payTo": "0x..." }] }

# With an x402-aware client, payment is automatic
$ x402-fetch https://api.grid402.xyz/combined/CAISO/TH_NP15_GEN-APND/live
{ "data": { "price": { "lmp_usd_per_mwh": 42.15 },
            "generation_mix_mw": { "gas": 4230, "solar": 5100, ... },
            "emissions": { "gco2_per_kwh": 185.3 } },
  "payment": { "tx_hash": "0x...", "amount_usd": 0.005 } }
```

## Why

Clean-energy accounting just shifted from once-a-year paperwork to **hour-by-hour receipts** worldwide. CBAM, IRA 45V, and EU RFNBO all converge on hourly matching by 2030. That turns the grid into a real-time data problem — but every existing vendor (Platts, Enverus, Electricity Maps) sells annual contracts to procurement teams. Nobody sells **sub-hourly generation mix** by the call, on-chain, to AI agents.

Grid402 does. **$0.005/call vs €6,000/year.**

## What's inside

| Package | Description |
|---|---|
| [`api/`](./api/) | Hono server with `@x402/hono` payment gating, CAISO 5-min ingestion, IPCC AR6 lifecycle emission factors |
| [`agent/`](./agent/) | Coinbase AgentKit + LangChain demo agent that calls Grid402 via x402 action provider |
| [`endpoints/`](./endpoints/) | Per-ISO data spec sheets — CAISO ✅, ERCOT, AEMO, ENTSO-E, KPX |
| [`hosts/`](./hosts/) | Hackathon stack integration specs — Base SDK, FLock, Nansen, Selanet |

## Crown jewel: sub-hourly generation mix

| ISO / Zone | Mix granularity | Status |
|---|---|---|
| **CAISO** (US California) | 5-min | ✅ live |
| **AEMO** (Australia) | 5-min (DUID-level) | spec done, parser next |
| **ERCOT** (US Texas) | 5-min (8-fuel JSON) | spec done |
| **KPX** (Korea) | **5-min** via OpenAPI | spec done — discovered via `sumperfuel5m` |
| **ENTSO-E** (EU 27 countries) | 15-min | next sprint |

These five ISOs cover ~50% of global electricity demand. Each one returns price + mix + self-computed `gCO2/kWh` in one unified JSON envelope.

## API endpoints (live MVP)

```
GET  /                              free metadata
GET  /spot/CAISO/:zone/live         $0.005   5-min LMP
GET  /mix/CAISO/live                $0.005   5-min generation mix
GET  /emissions/CAISO/live          $0.010   self-computed gCO2/kWh + share %
GET  /combined/CAISO/:zone/live     $0.015   price + mix + emissions
```

Same pattern repeats per ISO as we add them.

## Quick start

See [BUILD.md](./BUILD.md) for prerequisites, local dev, and deployment.

```bash
# Run the API
cd api && cp .env.example .env  # set EVM_ADDRESS
pnpm install && pnpm dev

# Run the demo agent
cd agent && cp .env.example .env  # set CDP keys + GRID402_URL
pnpm install && pnpm dev "What's the current CAISO NP15 price?"
```

## Architecture

```
Agent (Coinbase AgentKit + FLock LLM)
  ↓ x402 HTTP request
Grid402 API (Hono on Cloudflare Workers)
  ↓ verify USDC on Base via facilitator
Public ISO/RTO feeds (CAISO OASIS, ERCOT MIS, ENTSO-E, AEMO NEMWEB, KPX)
  ↓ normalize to canonical FuelType
IPCC AR6 lifecycle emission factor library
```

Every API call → one USDC tx on Base, settled in seconds via the [x402 protocol](https://x402.org).

## Use cases (three layers)

1. **Demand-side management** — AI workload schedulers, battery dispatch bots, EV charging optimizers shift to cheap+clean intervals.
2. **DePIN / EigenLayer AVS oracle** — smart contracts read Grid402 to slash or reward operators based on grid intensity at time T.
3. **Prediction markets** — Polymarket-style contracts on next-hour electricity prices, settled by Grid402 oracle.

See [CONCEPT_KR.md](./CONCEPT_KR.md) (Korean) for the full Layer 0 → 2 breakdown.

## Tech stack

**Runtime**: TypeScript · Hono · Cloudflare Workers · `@x402/hono` v2.10
**Data**: Public-domain ISO feeds (CAISO OASIS, ERCOT MIS, ENTSO-E Transparency, AEMO NEMWEB, KPX OpenAPI)
**Payments**: x402 protocol · USDC on Base · Coinbase facilitator
**Agent**: `@coinbase/agentkit` v0.10 · LangChain · LangGraph · OpenAI/FLock LLM
**Emissions**: IPCC AR6 WG3 lifecycle factors (self-computed, audit-traceable)

## Status

🚧 Pre-hackathon. CAISO live; AEMO/ERCOT/KPX spec'd. ENTSO-E next sprint.

## License

[MIT](./LICENSE)

## Documents

| File | Purpose |
|---|---|
| [`PRD.md`](./PRD.md) | Product requirements |
| [`CONCEPT_KR.md`](./CONCEPT_KR.md) | Layer 0–2 (agents · UC1/UC2/UC3) — Korean |
| [`DATA_RESEARCH_KR.md`](./DATA_RESEARCH_KR.md) | Electricity Maps benchmark |
| [`MAP_AND_KOREA_RESEARCH.md`](./MAP_AND_KOREA_RESEARCH.md) | Map SDK + Korea data sources |
| [`ENDPOINT_RESEARCH_PLAN.md`](./ENDPOINT_RESEARCH_PLAN.md) | 12-section plan, P0 → P3 priority matrix |
| [`BUILD.md`](./BUILD.md) | Run + deploy + facilitator registration |
