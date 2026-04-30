// agent-code-reviewer — thin entry. Owns its own Locus account + wallet.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBorrowerServer,
  registerWithCredit,
  systemPromptFor,
  type BorrowerConfig,
} from "@credit/borrower";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const agentId = req("AGENT_ID");
  const config: BorrowerConfig = {
    port: Number(process.env.PORT ?? "4002"),
    agentId,
    agentName: req("AGENT_NAME"),
    agentDescription: req("AGENT_DESCRIPTION"),
    geminiModel: req("AGENT_GEMINI_MODEL"),
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiApiBase:
      process.env.GEMINI_API_BASE ??
      "https://generativelanguage.googleapis.com/v1beta",
    systemPrompt: systemPromptFor(agentId),
    locusApiKey: req("LOCUS_API_KEY"),
    locusApiBase:
      process.env.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api",
    locusWebhookSecret: req("LOCUS_WEBHOOK_SECRET"),
    locusOfflineMode: process.env.LOCUS_OFFLINE_MODE === "1",
    mockBalance: process.env.LOCUS_MOCK_BALANCE,
    workPrice: Number(req("AGENT_PRICING_USDC")),
    workCost: Number(req("AGENT_WORK_COST_USDC")),
    safetyBuffer: Number(req("SAFETY_BUFFER")),
    creditAgentUrl: req("CREDIT_AGENT_URL"),
  };

  const { app, locus, credit } = await buildBorrowerServer(config);
  await app.listen({ port: config.port, host: "0.0.0.0" });

  try {
    const reg = await registerWithCredit(config, locus, credit);
    app.log.info({ reg }, "registered with credit");
  } catch (err) {
    app.log.warn({ err }, "registration with credit failed (continuing)");
  }

  app.log.info(
    `${config.agentName} (${config.agentId}) on http://localhost:${config.port} ` +
      `(locus mode: ${config.locusOfflineMode ? "offline/mock" : "live/beta"}, ` +
      `model: ${config.geminiModel})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
