# Grid402

> **Pay-per-call API for the world's electricity grid — sub-hourly mix, prices, and emissions, settled in USDC on Base via [x402](https://x402.org).**

🌐 **Live demo:** [grid402.climatebrain.xyz](https://grid402.climatebrain.xyz)
📦 **Repo:** [carbonsteward/grid402](https://github.com/carbonsteward/grid402)

The first agent-native data primitive for the grid. Real-time generation mix and carbon intensity for CAISO, ERCOT, GB (NESO), KPX, and AEMO — normalized into one schema, gated by HTTP 402.

```bash
$ curl -i https://grid402.climatebrain.xyz/api/mix/CAISO/live
HTTP/1.1 200 OK
{
  "iso": "CAISO",
  "ts": "2026-04-25T14:30:00Z",
  "ci_g_per_kwh": 118,
  "pct": { "solar": 38.4, "wind": 10.5, "gas": 18.7, "nuclear": 10.2, ... },
  "source": "live"
}
```

## Why Grid402

Clean-energy accounting just shifted from once-a-year paperwork to **hour-by-hour receipts**. CBAM, IRA 45V, and EU RFNBO all converge on hourly matching by 2030. That makes the grid a real-time data problem — but every existing vendor (Platts, Enverus, **Electricity Maps**) sells annual contracts to procurement teams. Nobody sells **sub-hourly generation mix** by the call, on-chain, to AI agents.

Grid402 does. **$0.005 per call vs €6,000 per year.**

## Live coverage

| Region | ISO / Operator | Mix granularity | Live? |
|---|---|---|---|
| 🇺🇸 California | CAISO | 5-min | ✅ real upstream (Today's Outlook CSV) |
| 🇬🇧 Great Britain | NESO | 30-min | ✅ real upstream ([carbonintensity.org.uk](https://api.carbonintensity.org.uk/), no key) |
| 🇺🇸 Texas | ERCOT | 5-min | 🟡 estimate (CF egress IPs blocked; v2: 60-day disclosure CSVs) |
| 🇰🇷 South Korea | KPX | 5–60 min | 🟡 estimate (data.go.kr key in env, v2: real upstream) |
| 🇦🇺 Australia (NEM) | AEMO | 5-min | 🟡 estimate (v2: NEMWEB direct) |

**Coming next:** ENTSO-E (27 EU countries with one token), NYISO, PJM.

## Repository layout

| Path | Description |
|---|---|
| [`web/`](./web/) | The live map + docs site (Astro + React + MapLibre + MDX). Deployed to Cloudflare Pages at [grid402.climatebrain.xyz](https://grid402.climatebrain.xyz). |
| [`api/`](./api/) | The full x402-gated API (Hono server, Node). Source of truth for the data fetchers; runs locally or on Railway/CF Workers. |
| [`agent/`](./agent/) | Coinbase AgentKit + LangChain demo agent that calls Grid402 via the x402 action provider. |
| [`endpoints/`](./endpoints/) | Per-ISO data spec sheets — CAISO, ERCOT, KPX, AEMO. |
| [`hosts/`](./hosts/) | Hackathon stack integration specs — Base SDK, FLock, Nansen, Selanet. |

## Live API endpoints

The deployed endpoints at `grid402.climatebrain.xyz/api` are **demo-tier** (free, no x402 gate). The full x402-gated production API lives in [`api/`](./api/) and runs separately.

```
GET  /api                            metadata + endpoint catalog
GET  /api/health                     health check
GET  /api/mix/{ISO}/live              live mix + carbon intensity
GET  /api/mix/{ISO}/history?hours=24  time-series (for the slider)
```

`{ISO}` is one of `CAISO`, `ERCOT`, `GB`, `KPX`, `AEMO`.

## How x402 gating works

Production endpoints (under `api/src/index.ts`) return `402 Payment Required` until the client attaches an x402-signed payload. The client signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization` (gasless), the facilitator broadcasts the USDC transfer on Base, and the API releases the JSON.

```
1. client → server          GET /mix/CAISO/live
2. server → client          402 Payment Required
                             { accepts: [{ network, amount, payTo, asset }] }
3. client signs             EIP-3009 transferWithAuthorization (gasless)
4. client → server          GET /mix/CAISO/live
                             X-PAYMENT: <base64-payload>
5. server → facilitator     verify
6. server → client          200 OK + JSON + X-PAYMENT-RESPONSE: <tx_hash>
```

See [`web/src/pages/docs/x402.mdx`](./web/src/pages/docs/x402.mdx) for the full spec.

## Run locally

```bash
# 1. The API (paid endpoints, x402-gated)
cd api && cp .env.example .env       # set EVM_ADDRESS to your Base wallet
pnpm install && pnpm dev             # → http://localhost:3402

# 2. The demo agent
cd agent && cp .env.example .env     # set CDP keys + GRID402_URL
pnpm install && pnpm dev "What's the current CAISO NP15 price?"

# 3. The web app (live map + docs)
cd web && cp .env.example .env       # PUBLIC_GRID402_API=http://localhost:3402
pnpm install && pnpm dev             # → http://localhost:4321
```

## Deployment

The web app deploys to Cloudflare Pages:

```bash
cd web
pnpm build
cp -r functions dist/functions       # bundle Pages Functions with static output
wrangler pages deploy dist --project-name grid402
```

Custom domain `grid402.climatebrain.xyz` is wired via Cloudflare DNS (CNAME → `grid402.pages.dev`).

## Tech stack

- **Web:** Astro · React 19 · Tailwind v4 · MDX · MapLibre GL · Carto Dark Matter basemap · Cloudflare Pages + Pages Functions
- **API:** TypeScript · Hono · `@x402/hono` v2.10 · Node 22 · `fast-xml-parser` · `fflate`
- **Payments:** x402 · USDC on Base · Coinbase facilitator
- **Agent:** `@coinbase/agentkit` v0.10 · LangChain · LangGraph · OpenAI / FLock
- **Emissions:** IPCC AR6 WG3 lifecycle factors (self-computed, audit-traceable)
- **Map data:** Natural Earth via `world-atlas` TopoJSON (110m), `d3-geo`, `topojson-client`

## Use cases

1. **Demand-side management** — AI workload schedulers, battery dispatch bots, EV charging optimizers shift to cheap+clean intervals.
2. **DePIN / EigenLayer AVS oracle** — smart contracts read Grid402 to slash or reward operators based on grid intensity at time T.
3. **Prediction markets** — Polymarket-style contracts on next-hour electricity prices, settled by a Grid402 oracle.

See [`CONCEPT_KR.md`](./CONCEPT_KR.md) (Korean) for the full Layer 0 → 2 breakdown.

## Comparison with Electricity Maps

Electricity Maps (electricitymaps.com) is the gold standard for global carbon intensity data. Grid402 differentiates on:

| | Electricity Maps | Grid402 |
|---|---|---|
| Pricing | Subscription (€6k/year+), API key | Pay per call ($0.005), no key |
| Onboarding | Email signup → dashboard → key | Wallet signature only |
| Granularity | hourly mostly | **5-min sub-hourly** (the moat) |
| Spot prices | ❌ | ✅ LMP/SMP/RRP |
| Settlement | Server-side billing | On-chain USDC tx per call |

The web demo at [grid402.climatebrain.xyz](https://grid402.climatebrain.xyz) is the open-source clone of their map UX, dark-themed.

## Status (v0.1.0-demo)

- 🟢 Live web demo with MapLibre choropleth + sidebar drilldown
- 🟢 5 ISOs wired (CAISO + GB live; ERCOT/KPX/AEMO realistic estimates)
- 🟢 Time-series history endpoint (`/api/mix/{ISO}/history`) for the slider
- 🟢 MDX docs (quickstart, x402, endpoints, ISOs)
- 🟢 Pre-commit hook (gitleaks) blocking secret leaks
- 🟢 Custom domain on Cloudflare DNS
- 🔴 Production x402-gated API not yet deployed (runs locally, deployment via Railway/Workers in v2)
- 🔴 ENTSO-E (token requested, not yet active)

## License

[MIT](./LICENSE)

## Project documents

| File | Purpose |
|---|---|
| [`PRD.md`](./PRD.md) | Product requirements |
| [`BUILD.md`](./BUILD.md) | Run + deploy + facilitator registration |
| [`CONCEPT_KR.md`](./CONCEPT_KR.md) | Layer 0–2 strategy (agents, use cases) — Korean |
| [`DATA_RESEARCH_KR.md`](./DATA_RESEARCH_KR.md) | Electricity Maps benchmark + global data source matrix |
| [`MAP_AND_KOREA_RESEARCH.md`](./MAP_AND_KOREA_RESEARCH.md) | Map SDK choices + Korea-specific upstream notes |
| [`ENDPOINT_RESEARCH_PLAN.md`](./ENDPOINT_RESEARCH_PLAN.md) | 12-section plan, P0 → P3 ISO priority matrix |
