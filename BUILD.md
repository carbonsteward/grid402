# Grid402 — MVP Scaffold

The first pay-per-call API for the world's electricity market's hourly/subhourly prices & emissions. Gated by x402 on Base.

This workspace contains two packages:

```
grid402/
├── api/          # the service — Hono + @x402/hono + CAISO fetcher
└── agent/        # AgentKit-based demo client that pays and consumes it
```

---

## 1 · Prerequisites

| Tool | Why | How |
|------|-----|------|
| **Node 20+** | runtime | `brew install node` or nvm |
| **pnpm** | workspace manager | `npm i -g pnpm` |
| **CDP API keys** | agent wallet | https://portal.cdp.coinbase.com/ → *Create Secret API Key* |
| **OpenAI API key** | demo LLM only | https://platform.openai.com/api-keys |
| **Base Sepolia USDC** | testnet funds for the agent | https://faucet.circle.com/ (pick Base Sepolia) |
| **A payee EVM address** | where Grid402 receives USDC | any wallet — Rainbow / MetaMask / CDP works |

Mainnet is identical but flip `NETWORK_ID=base` and spend real USDC. Everything below assumes Sepolia.

---

## 2 · Run the API server

```bash
cd .context/grid402/api
cp .env.example .env
# edit .env — set EVM_ADDRESS to your payee address
pnpm install
pnpm dev
```

You should see:

```
 Grid402 API listening on http://localhost:3402
   Network: eip155:84532
   PayTo:   0x...
   Facil:   https://x402.org/facilitator
```

Hit the free metadata endpoint:

```bash
curl http://localhost:3402/
```

Hit the paid endpoint without payment → **402 Payment Required** with an x402 challenge:

```bash
curl -i http://localhost:3402/spot/CAISO/TH_NP15_GEN-APND/live
# HTTP/1.1 402 Payment Required
# x-payment-required: 1
# { "accepts": [ { "scheme": "exact", "network": "eip155:84532", ... } ] }
```

That's the protocol working.

---

## 3 · Run the demo agent

```bash
cd .context/grid402/agent
cp .env.example .env
# edit .env — add CDP_API_KEY_ID / SECRET / WALLET_SECRET + OPENAI_API_KEY
pnpm install
pnpm dev
```

First run will provision a CDP-managed wallet on Base Sepolia. **Fund it with test USDC** from https://faucet.circle.com/ (paste the wallet address the agent prints on startup).

Then the agent will:

1. Take a prompt (default: *"Get the current CAISO NP15 spot price from Grid402 and tell me what you paid"*).
2. The LLM routes to the `make_http_request_with_x402` tool from `x402ActionProvider`.
3. AgentKit fires a plain GET at the endpoint → gets back 402 + challenge.
4. The CDP wallet signs the EIP-3009 USDC transferWithAuthorization for $0.005.
5. AgentKit retries with the signed payment header → Grid402 validates with the facilitator → returns the live CAISO tick.
6. The agent surfaces the price, the interval timestamp, and the on-chain tx hash.

Pass a custom prompt to `pnpm dev`:

```bash
pnpm dev "What was the last ZP26 spot price? Show me the transaction hash."
```

---

## 4 · Facilitator registration (the "discoverable by every AgentKit agent" story)

x402 has a discovery concept called a **facilitator**. A facilitator is a service that:
- Verifies payment signatures for a given scheme/network.
- Optionally lists known x402 services so agents can call `discover_x402_services` and find them by price, keyword, or category.

### 4a · Which facilitator to point Grid402 at

For the hackathon, use the Coinbase-hosted one — it supports Base + Base Sepolia out of the box:

```
FACILITATOR_URL=https://x402.org/facilitator
```

Alternatives (already live in the x402 ecosystem):

| Facilitator | Run by | When to pick it |
|---|---|---|
| `x402.org/facilitator` | Coinbase CDP | Default — Base mainnet + Sepolia |
| `facilitator.cloudflare.com` (path TBC) | Cloudflare | If deploying on Workers |
| AWS facilitator | AWS | For machine-to-machine cloud payments |
| **Self-hosted** | You | Full control, needed for custom networks |

See the full list: https://www.x402.org/ecosystem?category=facilitators

### 4b · Getting listed in `discover_x402_services`

The AgentKit x402 action provider ships a `discover_x402_services` tool — agents call it to find endpoints by price/keyword. For Grid402 to show up:

1. **Publish an OpenAPI 3.1 spec** describing every paid route with x402 extensions (schemes, prices, networks). The `@x402/hono` middleware emits these automatically at `/openapi.json` in v1.2+.
2. **Register with a facilitator that maintains a public catalog.** Today that's primarily Coinbase's — submission happens via their [Bazaar](https://github.com/coinbase/x402/tree/main/examples/typescript/servers/bazaar) flow (open a PR to the bazaar registry, or use their self-service portal once it launches).
3. **Self-register** inside the AgentKit session: any AgentKit agent can call `register_x402_service` at runtime to whitelist your URL. Useful for private pilots.

Practical hackathon path:
- **Day 1**: run self-facilitated (your server returns the facilitator URL it trusts).
- **Day 2**: submit to the Coinbase bazaar so `discover_x402_services` surfaces Grid402 globally.
- **Post-hackathon**: register on additional facilitator catalogs (Cloudflare, AWS) for redundancy and multi-chain reach.

### 4c · Why this matters for your pitch

Judges will ask *"how do agents find it?"* Answer:

> "Any agent running Coinbase AgentKit has the x402 action provider built in. They call `discover_x402_services` with a query like `\"electricity\"` or `\"CAISO\"`, Grid402 shows up in the catalog, and the agent can call us with zero SDK integration. We ship one OpenAPI file, they ship one npm install."

---

## 5 · What's next (post-MVP)

- **More ISOs**: ERCOT, PJM, MISO, NYISO, ISO-NE, ENTSO-E (27 EU countries), AEMO, BMRS, JEPX. All use the same Hono pattern — copy `caiso.ts` into `ercot.ts`, etc.
- **Derived signals**: `POST /arbitrage` composite endpoint that sorts hours by `$/MWh` for a given zone/window.
- **Emission intensity**: compute `gCO2/kWh` yourself from ENTSO-E / CAISO supply-mix data + IPCC factors. Your methodology, your license.
- **Cloudflare Workers deploy**: `@x402/hono` runs on Workers unchanged; port `fflate` already works there. Add a Worker Cron to pre-ingest every 5 min.
- **WebSocket streams**: Durable Objects + `$0.10/hr` subscription tier for live ticker clients.

---

## 6 · File index

| File | Purpose |
|---|---|
| `api/src/index.ts` | Hono app, x402 payment middleware, free + paid routes |
| `api/src/caiso.ts` | CAISO OASIS fetcher — zipped CSV → typed tick, 60s in-memory cache |
| `api/.env.example` | config for the API server (payee address + facilitator URL) |
| `agent/src/index.ts` | AgentKit + LangChain ReAct agent that calls Grid402 |
| `agent/.env.example` | config for the demo agent (CDP + OpenAI keys) |

---

## 7 · Pitch line (once the demo runs)

> *"Watch this. I type 'what's the current CAISO NP15 price?' The agent hits Grid402, gets a 402, pays half a cent in USDC on Base, and hands me back the cleared price. That's the first agent-native electricity market data primitive, and it works with every AgentKit agent on day one."*
