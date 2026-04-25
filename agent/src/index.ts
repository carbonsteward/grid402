// Grid402 demo agent
//
// A minimal LangChain ReAct agent running on Coinbase AgentKit, showing how
// *any* AgentKit-built agent can discover, pay, and consume Grid402 out of
// the box via the built-in x402 action provider.
//
// The user types a natural-language question ("what's the CAISO NP15 price?"),
// the LLM picks the `make_http_request_with_x402` tool, the wallet auto-pays
// the 402 challenge in USDC on Base Sepolia, and the response comes back
// as one of Grid402's JSON ticks.
//
// Run:    pnpm install && pnpm dev
// Try:    "Get the current CAISO NP15 spot price from Grid402."

import { config } from "dotenv";
import {
  AgentKit,
  CdpEvmWalletProvider,
  x402ActionProvider,
  walletActionProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

config();

async function main() {
  // ---- Wallet (CDP-managed, Base Sepolia for testnet demos) --------------
  const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: process.env.NETWORK_ID ?? "base-sepolia",
  });

  // ---- AgentKit, with x402 + wallet tools --------------------------------
  // Note: AgentKit 0.10.x x402ActionProvider takes no constructor args.
  // Whitelisting / max-payment is enforced at call time via the discoverX402Services
  // and retry_http_request_with_x402 tool args (the agent passes maxUsdcPrice).
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      walletActionProvider(),
      x402ActionProvider(),
    ],
  });

  // ---- Bind AgentKit tools into a LangChain ReAct agent ------------------
  const tools = await getLangChainTools(agentkit);
  const model = new ChatOpenAI({ model: "gpt-4.1-mini", temperature: 0 });

  const agent = createReactAgent({
    llm: model,
    tools,
    stateModifier: `
You are a demo agent for Grid402, a pay-per-call electricity market data API
gated by x402 on Base. When asked about spot prices, use the x402 tools to
hit ${process.env.GRID402_URL} and report the cleared price in USD/MWh.

Grid402 endpoints:
  GET ${process.env.GRID402_URL}/spot/CAISO/<zone>/live   ($0.005)
  Zones you can use: TH_NP15_GEN-APND, TH_SP15_GEN-APND, TH_ZP26_GEN-APND

Always surface (a) the price, (b) the interval timestamp, and (c) the
transaction hash of the USDC payment so the audience can follow the flow.
    `.trim(),
  });

  // ---- One-shot prompt for the demo --------------------------------------
  const prompt =
    process.argv.slice(2).join(" ") ||
    "Get the current CAISO NP15 spot price from Grid402 and tell me what you paid.";

  console.log(`\n🧑 user: ${prompt}\n`);

  const stream = await agent.stream(
    { messages: [new HumanMessage(prompt)] },
    { configurable: { thread_id: "grid402-demo" }, streamMode: "values" },
  );

  for await (const step of stream) {
    const last = step.messages?.[step.messages.length - 1];
    if (!last) continue;
    if (last.getType() === "ai") {
      const txt = (last.content as any)?.toString?.() ?? "";
      if (txt) console.log(`🤖 agent: ${txt}\n`);
    } else if (last.getType() === "tool") {
      console.log(`🔧 tool [${(last as any).name}]: ${String((last as any).content).slice(0, 400)}\n`);
    }
  }
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
