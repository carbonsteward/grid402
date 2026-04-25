<div align="center">

# Grid402

**The world's electricity grid, priced by the call.**

Pay-per-call API for sub-hourly carbon intensity, generation mix, and spot prices — settled on-chain in USDC on Base via the [x402](https://x402.org) protocol.

[**🌐 Live demo →**](https://grid402.climatebrain.xyz) &nbsp;·&nbsp; [Docs](https://grid402.climatebrain.xyz/docs) &nbsp;·&nbsp; [How x402 works](https://grid402.climatebrain.xyz/docs/x402) &nbsp;·&nbsp; [Endpoints](https://grid402.climatebrain.xyz/docs/endpoints)

![Grid402 live map](docs/hero.png)

</div>

---

## What this is

Grid402 is a **data primitive for AI agents**. It exposes the world's electricity grid — generation mix, carbon intensity, spot prices — as plain HTTP, metered per request, settled in USDC on Base. No keys, no dashboards, no annual contracts. The HTTP request *is* the on-chain payment.

The live demo above is also a working **open-source clone of [Electricity Maps](https://app.electricitymaps.com)**, dark-themed with the [ClimateBrain](https://climatebrain.xyz) brand. Same visual language as the gold-standard reference, with sub-national choropleth, time slider, and click-to-drill sidebar — all served from a single Cloudflare Pages deploy.

## Why this exists

> Clean-energy accounting just shifted from once-a-year paperwork to **hour-by-hour receipts**.

Three regulations are converging worldwide and all of them require **hourly matching**:

| Regulation | Region | Hourly matching by | What it forces |
|---|---|---|---|
| **CBAM** | EU | 2026 (now) | Importers of electricity, steel, aluminum, fertilizer must declare hourly emissions |
| **IRA 45V** | US | 2030 | Clean-hydrogen producers must match power hourly to claim the tax credit |
| **EU RFNBO** | EU | 2030 | Renewable hydrogen / e-fuels must be matched hourly |

That shift turns the grid into a **real-time programming problem** for every company producing hydrogen, importing steel, running data centers, or claiming 24/7 clean energy.

Today, the data sits behind:
- **Enterprise vendors** (Platts, Enverus, Kpler) — five-figure annual contracts, sales calls, RFPs, custom feeds.
- **Electricity Maps** — €6,000/year *per signal*, no redistribution, AGPL-3.0 parsers.
- **Raw ISO/RTO feeds** — 12 governments, 12 schemas, 12 auth flows. Free but unusable as a single primitive.

None of them sell to **software**. Grid402 does — by the call, on-chain, in seconds.

## The crown jewel: sub-hourly mix

Most vendors ship **hourly** generation mix. The whole reason hourly matching is a hard regulation is that it doesn't match human procurement timelines anymore. The signal that makes 24/7 CFE verification, hourly CBAM reports, and DePIN slashing decisions actually computable is **5-minute generation mix per ISO region** — direct from each grid operator's public dispatch feed.

That's what Grid402 ships. **Same technical signal Electricity Maps gates at €6,000/year, sold at $0.005/call**, because the upstream (CAISO, ERCOT, NESO, KPX, AEMO) is already public at that granularity. The market inefficiency was never the data — it was the billing shape.

## The dual role of agents

AI agents are not just data **consumers** — they're physical **grid loads** themselves. Every LLM inference (~1 Wh per 200 tokens), every HTTP I/O (~0.05 Wh), every wallet signature, every smart-contract execution runs on a GPU somewhere on a real grid. So Grid402 serves two functions for the same agent:

1. **Data consumer** — agent calls Grid402 for energy prices/emissions to make decisions about external workloads (workload scheduling, DePIN reward routing, prediction-market resolution).
2. **Self-knowledge layer** *(v2)* — agent calls Grid402 to know *its own* grid carbon footprint per session (`/whereami`, `/footprint/session`, `/route/cleanest`).

This is the only API that lets autonomous software introspect its own environmental cost in real time.

## Live coverage

| Region | ISO / Operator | Mix granularity | Status |
|---|---|---|---|
| 🇺🇸 California | **CAISO** | 5-min | ✅ live (Today's Outlook CSV) |
| 🇬🇧 Great Britain | **NESO** | 30-min | ✅ live ([carbonintensity.org.uk](https://api.carbonintensity.org.uk/), no key needed) |
| 🇦🇺 Australia (NEM) | **AEMO** | 5-min, 5 sub-state regions | 🟡 estimate — 5 distinct regional profiles (NSW1/QLD1/SA1/TAS1/VIC1) |
| 🇺🇸 Texas | **ERCOT** | 5-min | 🟡 estimate (CF egress IPs blocked from ERCOT dashboard JSON) |
| 🇰🇷 South Korea | **KPX** | 5–60 min | 🟡 estimate (key in env, real upstream in v2) |

**On the roadmap:** ENTSO-E (27 EU countries with one token), NYISO, PJM, AEMO real upstream, KPX real upstream.

The **AU sub-state regions** are particularly fun to look at — Tasmania runs ~50 gCO₂/kWh on hydro while Queensland runs 600+ on coal, all visible at a glance on the map.

## Try it (5 seconds)

```bash
curl https://grid402.climatebrain.xyz/api/mix/CAISO/live
# → { "iso": "CAISO", "ts": "...", "ci_g_per_kwh": 118,
#     "pct": { "solar": 38.4, "wind": 10.5, "gas": 18.7, ... },
#     "source": "live" }

curl https://grid402.climatebrain.xyz/api/mix/AEMO/live?region=TAS1
# → { "iso": "AEMO", "zone": "TAS1", "ci_g_per_kwh": 53,
#     "pct": { "hydro": 75, "wind": 15, ... } }

curl https://grid402.climatebrain.xyz/api/spot/AEMO/NSW1/live
# → { "iso": "AEMO", "zone": "NSW1", "price_usd_per_mwh": 90.47,
#     "price_native": 139, "currency": "AUD" }
```

The deployed `/api` is the **demo tier** — no x402 gate, free, rate-limited at the CDN edge. The full x402-gated production API lives in [`api/`](./api/) and runs locally or on Railway/Workers.

## How x402 works

Every paid endpoint returns `402 Payment Required` until the client attaches an x402-signed payload. The client signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization` (gasless), the facilitator broadcasts the USDC transfer on Base, and the API releases the JSON.

```
1. client → server          GET /mix/CAISO/live
2. server → client          402 Payment Required
                             { accepts: [{ network, amount, payTo, asset }] }
3. client signs             EIP-3009 transferWithAuthorization (gasless)
4. client → server          GET /mix/CAISO/live  +  X-PAYMENT: <base64>
5. server → facilitator     verify
6. server → client          200 OK + JSON  +  X-PAYMENT-RESPONSE: <tx_hash>
```

Any AI agent using **[Coinbase AgentKit](https://docs.cdp.coinbase.com/agentkit/welcome)** already has the `x402ActionProvider` built in. That means an agent can call Grid402 with **zero Grid402-specific code** — the x402 protocol handles discovery, payment, and replay-protection.

```ts
agentkit.use(x402ActionProvider({
  registeredServices: ["https://api.grid402.xyz"],
  maxPaymentUsdc: 0.10,
}));
// agent prompt: "what's the current CAISO NP15 carbon intensity?"
// → agent hits us, pays, returns data. Day one. No SDK.
```

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  AI agent (Coinbase AgentKit + LangChain + FLock LLM)             │
│  CDP Smart Wallet on Base                                         │
└──────┬────────────────────────────────────────────────────────────┘
       │ GET /api/mix/CAISO/live   (HTTP/1.1 with X-PAYMENT header)
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  Grid402 web — Cloudflare Pages                                   │
│   • Astro + React + MapLibre  (the live map demo)                 │
│   • Pages Functions  (free-tier /api/* routes)                    │
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  Grid402 API — Hono + @x402/hono  (Node, runs locally / Railway)  │
│   • 402 challenge → x402 verify → release JSON                    │
│   • In-memory 60s cache per ISO + zone                            │
└──┬─────────────────┬───────────────────────────────────────────┬──┘
   │ x402            │ upstream                                  │
   ▼                 ▼                                            ▼
┌─────────────┐ ┌─────────────────────────────────┐    ┌──────────────────┐
│ Coinbase    │ │ Public ISO/RTO feeds            │    │ IPCC AR6 WG3     │
│ facilitator │ │  • CAISO Today's Outlook CSV    │    │ lifecycle factor │
│ (USDC on    │ │  • NESO carbonintensity.org.uk  │    │ library          │
│  Base)      │ │  • ERCOT, AEMO, KPX, ENTSO-E    │    │ (audit-traceable)│
└─────────────┘ └─────────────────────────────────┘    └──────────────────┘
```

Emissions are **self-computed** as `gCO₂/kWh = Σ (fuel_MW × IPCC_lifecycle_factor) / total_MW`, so every response is independently auditable. We do not redistribute Electricity Maps' carbon-intensity numbers; the methodology and factor source are disclosed in [`api/src/emission-factors.ts`](./api/src/emission-factors.ts).

## Repository layout

| Path | Description |
|---|---|
| [`web/`](./web/) | Live map + docs site. Astro + React + MapLibre + MDX. Deployed to Cloudflare Pages at [grid402.climatebrain.xyz](https://grid402.climatebrain.xyz). |
| [`api/`](./api/) | The x402-gated API. Hono server with `@x402/hono` middleware, paid endpoints for spot / mix / emissions / combined. |
| [`agent/`](./agent/) | Coinbase AgentKit + LangChain demo agent that calls Grid402 over x402. |
| [`endpoints/`](./endpoints/) | Per-ISO data spec sheets (CAISO, ERCOT, KPX, AEMO) with upstream URLs and parser notes. |
| [`hosts/`](./hosts/) | Hackathon stack integration spec for Coinbase AgentKit. |

## Run locally

```bash
# 1. The API (paid endpoints, x402-gated)
cd api && cp .env.example .env       # set EVM_ADDRESS to your Base wallet
pnpm install && pnpm dev             # → http://localhost:3402

# 2. The demo agent
cd agent && cp .env.example .env     # set CDP keys + GRID402_URL
pnpm install && pnpm dev "What's the current CAISO carbon intensity?"

# 3. The web app (live map + docs)
cd web && cp .env.example .env       # PUBLIC_GRID402_API=http://localhost:3402
pnpm install && pnpm dev             # → http://localhost:4321
```

## Deploy

```bash
cd web
pnpm build
cp -r functions dist/functions       # bundle Pages Functions with static output
wrangler pages deploy dist --project-name grid402
```

Custom domain `grid402.climatebrain.xyz` is wired via Cloudflare DNS (CNAME → `grid402.pages.dev`).

## Tech stack

- **Web** — Astro · React 19 · Tailwind v4 · MDX · MapLibre GL · Carto Dark Matter basemap · Cloudflare Pages + Pages Functions
- **API** — TypeScript · Hono 4.9 · `@x402/hono` v2.10 · Node 22 · `fast-xml-parser` · `fflate`
- **Payments** — x402 · USDC on Base · Coinbase facilitator · EIP-3009 `transferWithAuthorization`
- **Agent** — `@coinbase/agentkit` v0.10 · LangChain · LangGraph · OpenAI / FLock
- **Emissions** — IPCC AR6 WG3 lifecycle factors (Annex III Table A.III.2, 2022) — self-computed, audit-traceable
- **Map data** — Natural Earth via `world-atlas` TopoJSON (110m), Australian states GeoJSON, `d3-geo`, `topojson-client`

## Use cases

1. **Carbon-aware compute scheduling** — AI workload schedulers, crypto miners, data-center load shifters route compute to hours/regions when the grid is cheap *and* clean.
2. **Battery dispatch & EV charging optimization** — bots arbitrage real-time spot prices and CI together.
3. **DePIN / EigenLayer AVS oracle** — smart contracts read Grid402 to slash or reward operators based on grid intensity at time T (e.g. Akash, io.net, Filecoin operator scoring).
4. **Tokenized PPA / energy derivatives** — settlement oracle for on-chain power purchase agreements and electricity index tokens.
5. **Prediction markets** — Polymarket-style contracts on next-hour electricity prices, settled by Grid402 as a trust-minimized oracle.
6. **Hourly compliance reporting** — CBAM importers, IRA 45V hydrogen producers, RFNBO e-fuel makers automate hourly emission attestation.

## Comparison with Electricity Maps

[Electricity Maps](https://app.electricitymaps.com) is the gold-standard reference for global carbon-intensity data. Grid402 differentiates on:

| | Electricity Maps | Grid402 |
|---|---|---|
| **Pricing** | Subscription (€6k+/year per signal), API key | Pay per call (~$0.005), no key |
| **Onboarding** | Email signup → dashboard → contract → key | Wallet signature only |
| **Granularity** | Mostly hourly | **5-min sub-hourly** (the moat) |
| **Spot prices** | ❌ | ✅ LMP / SMP / RRP per zone |
| **Settlement** | Server-side billing | On-chain USDC tx per call |
| **Map UI** | Closed source | **Open source (MIT)**, this repo |

Same data layer, different billing shape. The [live demo](https://grid402.climatebrain.xyz) is intentionally a visual mirror — same warm-earth choropleth gradient, same click-to-drill sidebar architecture, same time slider — built dark-themed in the ClimateBrain palette to make the comparison legible.

## Ethical & legal guardrails

These are hard constraints, not nice-to-haves:

1. **Public-domain or open-license upstream only.** No Electricity Maps, Nord Pool, or Platts redistribution.
2. **Every emission figure is self-computed** from the published mix × IPCC AR6 factors. Methodology and factor source are disclosed in every response.
3. **Attribution everywhere.** Each payload names the upstream publisher (e.g. `"source_url": "https://www.caiso.com/TodaysOutlook/..."`).
4. **No retail utility scraping.** CFAA and ToS gray zone — out of scope.
5. **No greenwashing claims.** Grid402 sells signals. Anyone building a "carbon-aware" product on top defends their own claim.

## Status

- 🟢 Live web demo with MapLibre choropleth, AU sub-state regions, time slider, and slide-in detail panel
- 🟢 5 ISOs wired (CAISO + GB live; ERCOT/AEMO/KPX realistic estimates with diurnal curves)
- 🟢 24h history endpoint (`/api/mix/{ISO}/history`) and spot price endpoint (`/api/spot/{ISO}/{zone}/live`)
- 🟢 MDX docs (Quickstart, Endpoints, x402 protocol, ISO coverage)
- 🟢 Pre-commit hook (gitleaks) + CI-ready repo
- 🟢 Custom domain on Cloudflare DNS, end-to-end TLS via Google CA
- 🔴 Production x402-gated API not yet deployed at a public URL (runs locally; v2 = Railway / Workers)
- 🔴 ENTSO-E (27 EU countries — token requested, awaiting activation)
- 🔴 Real ERCOT / AEMO / KPX upstream (in flight)

## Acknowledgements

Built for the Base hackathon. Stack hosts: **[Coinbase AgentKit](https://docs.cdp.coinbase.com/agentkit/welcome)** (agent body + x402 SDK + CDP wallet), Coinbase Developer Platform x402 facilitator. Carto Dark Matter basemap. Natural Earth + `rowanhogan/australian-states` GeoJSON.

Brand: **[Climatebrain](https://climatebrain.xyz)** — Powering Sustainable Economies with AI-Driven Insights.

## License

[MIT](./LICENSE)
