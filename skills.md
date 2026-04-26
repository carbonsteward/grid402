---
name: grid402-skill-set
description: Curated catalog of the six skills (timing, wallet, reasoning, self-observation, context, discovery) an autonomous agent needs for programmable demand response on Base. Grid402 ships skill 1; CDP, FLock, Nansen, Selanet, and AgentKit ship the others. Drop this file into any agent repo as a knowledge skill.
license: MIT
maintainer: Grid402
last_updated: 2026-04-25
homepage: https://grid402.climatebrain.xyz/docs/skills
repository: https://github.com/carbonsteward/grid402
---

# Agent Skill Set for Programmable Demand Response

A curated catalog of the skills an autonomous agent needs to execute per-call demand response on Base — choosing when to run, where to route compute, how to pay, and how to observe its own behavior on chain.

Grid402 ships one of these skills (timing/grid receipts). The other five exist already in adjacent infrastructure on or near Base. This document is the curated catalog so any developer can wire a complete agent without hunting across five unrelated vendor docs.

> **What kind of "skill" is this file?** A *knowledge skill* — pure markdown context that any agent runtime (Anthropic Claude Skills, Cursor rules, MCP context, AgentKit system prompt) can load to understand the six-skill landscape. The *executable* counterparts ship in V1: `@grid402/agentkit-action-provider` (npm) and an MCP server at `mcp.grid402.xyz`.

---

## What this document is for

If you are building an autonomous agent that responds to grid signals — shifting compute to greener hours, routing GPU workloads to cleaner regions, or producing on-chain proof of its carbon footprint — your agent needs more than one API. It needs a coherent set of skills, each of which sells per-call (or close to it) on Base.

This document lists those skills, attributes each to its provider, and explains exactly how to wire each one into a Coinbase AgentKit, LangChain, Vercel AI SDK, OpenAI Agents SDK, or MCP-host runtime.

## A note on the term "skill"

Different ecosystems use different vocabulary for the same primitive:

| Ecosystem | Term used |
|---|---|
| Anthropic Claude | Skills |
| Coinbase AgentKit | Action Providers |
| Model Context Protocol (MCP) | Tools |
| LangChain | Tools |
| Vercel AI SDK | Tools |
| Selanet platform | Skills |
| OpenAI Agents SDK | Tools |

This document uses **skill** as the umbrella term. Each section below shows how to expose the skill in whichever vocabulary your runtime expects.

---

## The six skills

| # | Skill | Provider | What the agent gets | Settled on |
|---|---|---|---|---|
| 1 | Grid receipts (timing and routing) | **Grid402** | per-call generation mix, emissions, and wholesale price for any supported ISO region | x402 USDC on Base |
| 2 | Wallet and payment | **Coinbase CDP Server Wallet** | EIP-3009 signing, USDC custody, gasless transfers | (signs Base transactions) |
| 3 | Reasoning | **FLock** (or any OpenAI-compatible LLM provider) | LLM inference per token | per-token API billing |
| 4 | Self-observation | **Nansen** | own wallet history, peer labels, payee traction, multi-chain wallet analytics | per-call credits (REST) or x402 (CLI mode) |
| 5 | Context (web and social) | **Selanet** | scrape Twitter / Xiaohongshu / YouTube / LinkedIn / free-form URLs through a network of real browser nodes | x402 USDC on Base |
| 6 | Discovery | **Coinbase AgentKit + x402 Bazaar** | `discover_x402_services` and `register_x402_service` for auto-finding paid endpoints by keyword | free at the discovery step; per-call USDC at execution |

An agent wired with all six is fully equipped to:
- decide when and where to run (skill 1)
- execute its own payments without human intervention (skill 2)
- reason about the data it pays for (skill 3)
- observe its own treasury and the wallets it interacts with (skill 4)
- gather unstructured context from the open web (skill 5)
- discover new skills as the ecosystem grows (skill 6)

---

## Wiring example: one prompt, six skills

A minimal Coinbase AgentKit + LangGraph runtime that exposes all six skills:

```ts
import { config } from "dotenv";
import {
  AgentKit,
  CdpEvmWalletProvider,
  walletActionProvider,
  x402ActionProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { grid402ActionProvider } from "./skills/grid402.js";   // skill 1
import { nansenActionProvider }  from "./skills/nansen.js";    // skill 4
import { selanetActionProvider } from "./skills/selanet.js";   // skill 5

config();

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId:     process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  walletSecret: process.env.CDP_WALLET_SECRET!,
  networkId:    process.env.NETWORK_ID ?? "base-sepolia",
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    walletActionProvider(),       // skill 2: wallet and payment
    x402ActionProvider(),         // skill 6: discovery + paid HTTP
    grid402ActionProvider(),      // skill 1: grid receipts
    nansenActionProvider(),       // skill 4: self-observation
    selanetActionProvider(),      // skill 5: context (web/social)
  ],
});

const tools = await getLangChainTools(agentkit);

// skill 3: reasoning — FLock as OpenAI-compatible drop-in
const model = new ChatOpenAI({
  model:   process.env.FLOCK_MODEL    ?? "qwen3-235b-a22b-thinking-2507",
  apiKey:  process.env.FLOCK_LLM_API_KEY,
  configuration: { baseURL: process.env.FLOCK_BASE_URL ?? "https://api.flock.io/v1" },
  temperature: 0,
});

const agent = createReactAgent({ llm: model, tools });
```

A single prompt — *"Find the cleanest 4-hour window in CAISO NP15 today, check whether my wallet has paid for similar data this month, and pull any X.com posts mentioning a CAISO blackout in the last 24 hours"* — exercises every one of the six skills in order.

---

## Per-skill install and call patterns

### 1. Grid receipts (Grid402)

**What it is:** Per-call HTTP aggregation of the world's electricity grid — generation mix (5-min granularity), self-computed emissions (mix × IPCC AR6 lifecycle factors), and wholesale spot prices (LMP / SMP / RRP) — across CAISO, AEMO, NESO, KPX, ERCOT (with ENTSO-E and PJM in V1).

**Surfaces:**
- HTTP API gated by x402 USDC on Base (live)
- MCP server (V1, planned at `mcp.grid402.xyz`)
- AgentKit Action Provider package (V1, planned `@grid402/agentkit-action-provider`)

**Auth:** None. Wallet signature on x402 challenge replaces API key.

**Sample call (curl):**
```bash
# Without payment: 402 challenge with terms
curl -i https://api.grid402.xyz/combined/CAISO/TH_NP15_GEN-APND/live

# With x402 client: payment automatic, JSON returned
x402-fetch https://api.grid402.xyz/combined/CAISO/TH_NP15_GEN-APND/live
```

**Sample call (AgentKit):**
```ts
// the x402ActionProvider tool make_http_request_with_x402 handles this
// agent prompt: "What's the current CAISO mix?"
//   -> agent calls make_http_request_with_x402
//   -> server returns 402, agent retries with EIP-3009 signature
//   -> 200 OK with mix + emissions + spot in one envelope
```

**Pricing:** $0.005 (mix), $0.005 (spot), $0.010 (emissions), $0.015 (combined).

---

### 2. Wallet and payment (Coinbase CDP Server Wallet)

**What it is:** Programmatic, custodial-grade EVM wallet with TEE-protected signing. Provides EIP-3009 `transferWithAuthorization` for gasless USDC payments — the underlying primitive that x402 settlement uses.

**Surfaces:**
- AgentKit `walletActionProvider` (built into `@coinbase/agentkit`)
- CDP SDK direct usage
- REST API at `api.cdp.coinbase.com`

**Auth:**
- `CDP_API_KEY_ID` (UUID) — REST authentication
- `CDP_API_KEY_SECRET` (Ed25519 base64 64-byte) — signs JWT
- `CDP_WALLET_SECRET` (EC P-256 PEM) — signs wallet operations (separate from API key)
- Optional `IDEMPOTENCY_KEY` for deterministic wallet address across runs

**Sample wire (AgentKit):**
```ts
import { CdpEvmWalletProvider, walletActionProvider } from "@coinbase/agentkit";

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId:     process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  walletSecret: process.env.CDP_WALLET_SECRET!,
  networkId:    "base-sepolia",
});

// then pass walletProvider into AgentKit.from({ walletProvider, actionProviders: [walletActionProvider(), ...] })
```

**Pricing:** Free for CDP API auth. USDC transfers cost gas paid by the x402 facilitator (Coinbase or third-party); the agent only signs.

---

### 3. Reasoning (FLock or compatible LLM)

**What it is:** LLM inference for the agent's brain. The agent uses an LLM to parse intent, choose tools, summarize results, and produce final answers.

**Why FLock specifically:** FLock exposes an OpenAI-compatible API at `https://api.flock.io/v1` and serves a network of decentralized GPU operators. $FLOCK token settles on Base, giving the entire agent stack a single-chain story. Twelve text/image/video models from six providers (Qwen, Kimi, MiniMax, DeepSeek, Google Gemini, Zai GLM) are accessible through one key.

**Substitutes:** Any OpenAI-compatible endpoint works. Anthropic Claude, OpenAI, Mistral, Together, Groq all drop in.

**Surfaces:** OpenAI-compatible HTTP. LangChain `ChatOpenAI` with overridden `baseURL`.

**Auth:** `sk-...` API key (LiteLLM virtual key format), passed as bearer or as `apiKey` in the LangChain client.

**Sample wire (LangChain):**
```ts
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model:   "qwen3-235b-a22b-thinking-2507",  // best for tool calling
  apiKey:  process.env.FLOCK_LLM_API_KEY,
  configuration: { baseURL: "https://api.flock.io/v1" },
  temperature: 0,
});
```

**Pricing:** Per-token, billed against an account quota ($0.001–0.01 per 1K output tokens depending on model). Pay via FLock's billing portal or, in the future, via $FLOCK staking.

---

### 4. Self-observation (Nansen)

**What it is:** Onchain analytics — own wallet history, transaction labels, peer reputation, payee traction monitoring, prediction-market analytics, multi-chain coverage (18+ research chains, 35 MCP tools).

**Use cases for an agent:**
- Confirm its own treasury balance and recent inflows
- Label the counterparty wallets that have paid it (or that it is about to pay)
- Detect Smart Money or Fund-labeled wallets in its caller graph
- Pull peer activity on a token before deciding to buy

**Surfaces:**
- MCP server at `https://mcp.nansen.ai/ra/mcp` (35 tools, header `NANSEN-API-KEY: nsn_...`)
- REST API at `https://api.nansen.ai` (76 commands)
- CLI (`nansen`) for ad-hoc and scripts
- LangChain Tool wrapper (build your own — see `./agent/src/skills/nansen.ts` for a starter)

**Auth:** `NANSEN_API_KEY` (`nsn_...`). Plan-based credit budget; most useful endpoints are 1 credit each.

**Sample MCP install (Claude Desktop / Cursor):**
```json
{
  "mcpServers": {
    "nansen": {
      "url": "https://mcp.nansen.ai/ra/mcp",
      "headers": {
        "NANSEN-API-KEY": "nsn_...",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

**Sample REST call:**
```bash
curl -sS https://api.nansen.ai/api/v1/profiler/transactions \
  -H "apiKey: nsn_..." \
  -H "Content-Type: application/json" \
  -d '{"address":"0x398Ca8353eCdF2Cd87610a073813a8BD97E39872","chain":"base-sepolia","days":7}'
```

**Pricing:** Plan-based; 1–500 credits per call depending on endpoint. `profiler/transactions` and `profiler/balance` are 1 credit each. `profiler/labels` is 100 credits common / 500 premium — cache aggressively.

**Redistribution note:** Smart Money endpoints are not redistributable to end users. Use them internally only.

---

### 5. Context (Selanet)

**What it is:** A decentralized network of real browser nodes (71 nodes today, 51 percent in Korea) that scrape Twitter, Xiaohongshu, YouTube, LinkedIn, and arbitrary URLs on behalf of the agent. Each request is paid via x402 USDC on Base. Native KR coverage is the asymmetric advantage.

**Use cases for an agent:**
- Add Korean-language news context to a KPX grid query
- Pull recent X.com posts mentioning a blackout, outage, or grid event
- Convert a free-form URL into Markdown for downstream LLM ingestion

**Surfaces:**
- HTTP API at `api.selanet.ai/v1`
- LangChain Tool wrapper (build your own — see `./agent/src/skills/selanet.ts` for a starter)

**Auth:** `Authorization: Bearer sk_live_...` (Selanet API key from dashboard)

**Sample call:**
```bash
curl -sS -X POST https://api.selanet.ai/v1/browse \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://wikipedia.org","format":"markdown"}'
```

Body schema (exactly one of):
- `url` + `format` (`markdown` or `html`) — free-form URL extraction
- `x_params: { feature: "search" | "profile" | "post", ... }`
- `youtube_params: { feature: "search" | "watch" | "comments", ... }`
- `linkedin_params: { feature: "search_all" | "search_people" | "in" | "company" | ... }`
- `xiaohongshu_params` / `rednote_params: { feature: ... }`

**Pricing:** Per-call, with multipliers per platform (X is 1.5x, Xiaohongshu is 3x base). Settled in USDC on Base via x402.

**Operational note:** A `NO_AGENTS / agent login expired` error means the routing pool has no logged-in node for the requested platform. Resolve by opening the Selanet dashboard Playground tab to refresh the routing key, or by requesting a fresh node assignment.

---

### 6. Discovery (Coinbase AgentKit + x402 Bazaar)

**What it is:** A built-in tool surface that lets an agent find paid x402 services by keyword and register new endpoints at runtime. The Bazaar is a public catalog of services; `discover_x402_services` is the search interface.

**Surfaces:**
- AgentKit `x402ActionProvider` — built into `@coinbase/agentkit`
- Direct Bazaar API (curated registry on the x402 ecosystem repo)

**Auth:** None for discovery. Per-call USDC for execution.

**Sample wire:**
```ts
import { x402ActionProvider } from "@coinbase/agentkit";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    x402ActionProvider(),  // exposes:
                           //   - discover_x402_services({ keyword, maxUsdcPrice, x402Versions, facilitator })
                           //   - make_http_request (returns 402 challenge)
                           //   - retry_http_request_with_x402 (signs + retries)
  ],
});

// agent prompt: "Find any electricity-grid API on Bazaar and call it"
//   -> agent calls discover_x402_services({ keyword: "electricity" })
//   -> picks Grid402, calls /combined endpoint, pays, returns data
```

**Pricing:** Free for discovery. Each downstream paid call costs whatever the discovered server charges.

---

## Minimum viable agents — when fewer than six skills work

Not every agent needs all six. The skill set decomposes by use case:

| Use case | Required skills | Optional |
|---|---|---|
| Carbon-aware compute scheduler that runs in one fixed region | 1 (Grid402), 2 (CDP), 3 (LLM) | 4 (Nansen), 6 (Discovery) |
| DePIN green-routing oracle (smart contract reading Grid402) | 1 (Grid402) only — solidity contract calls x402 directly, no LLM | n/a |
| Korean-context news enrichment | 1 (Grid402), 2 (CDP), 5 (Selanet) | 3 (LLM) for synthesis |
| Treasury monitoring agent (no compute decisions) | 2 (CDP), 4 (Nansen) | 3 (LLM) for daily summary |
| Multi-region GPU router that justifies decisions on chain | 1 (Grid402), 2 (CDP), 3 (LLM), 6 (Discovery) — and V3 attestation when shipping | 5 (Selanet) for context |

The full six-skill stack is the upper bound. Most production agents use three to five.

---

## Roadmap — what changes about this catalog

### V1 (4 weeks from MVP)
- Grid402 ships its own MCP server at `mcp.grid402.xyz`, mirroring Nansen's pattern
- `@grid402/agentkit-action-provider` npm package published — single-line install for AgentKit users
- Grid402 listed in x402 Bazaar so `discover_x402_services({ keyword: "electricity" })` returns it

### V2 (12 weeks)
- Skill 1 expands with decision endpoints (`/cleanest-window`, `/run-now`, `/best-region-now`) — collapses common client-side ranking logic into one call
- Skill 1 adds self-knowledge endpoints (`/whereami`, `/footprint/session`) — the agent introspects its own grid carbon
- FLock partnership lands: an LLM router that routes inference to greener operators using Grid402 timing data

### V3 (6 months)
- Skill 1 adds on-chain attestation (`/attestation/<tx_hash>` with EIP-712 signatures) — DePIN protocols and EigenLayer AVSs can verify carbon claims trustlessly
- Cross-chain settlement (Solana via x402 SVM scheme) — same skill set, second chain

The goal is that this six-skill catalog stays stable while each skill internally improves. New skills (storage, identity, compute marketplaces) get added by extension, not by replacing what is here.

---

## Contributing

If you operate an x402-native paid endpoint that other autonomous agents would want to reach for, open a PR against this document. The bar is:

1. The endpoint settles per-call (or per-stream) — annual subscriptions do not qualify
2. The endpoint is callable from a wallet without a human-onboarding step
3. There is a reasonable path to install the skill into AgentKit, MCP, or LangChain runtimes (or you ship that wrapper as part of the PR)

Send pull requests against `skills.md` in the [Grid402 repo](https://github.com/carbonsteward/grid402) (or whichever upstream curates this catalog). The catalog is intentionally short — the goal is a coherent skill set, not an exhaustive vendor list.

---

## License

This document is MIT-licensed. Each skill listed above is governed by its provider's own license and terms; this catalog only documents the integration surface.
