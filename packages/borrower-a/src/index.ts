// Thin entry: load .env, build the shared borrower server, register, listen.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBorrowerServer,
  registerWithCredit,
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
  const config: BorrowerConfig = {
    port: Number(process.env.PORT ?? "4001"),
    borrowerId: req("BORROWER_ID"),
    locusApiKey: req("LOCUS_API_KEY"),
    locusApiBase:
      process.env.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api",
    locusWebhookSecret: req("LOCUS_WEBHOOK_SECRET"),
    locusOfflineMode: process.env.LOCUS_OFFLINE_MODE === "1",
    mockBalance: process.env.LOCUS_MOCK_BALANCE,
    workPrice: Number(req("WORK_PRICE")),
    workCost: Number(req("WORK_COST")),
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
    `borrower-a (${config.borrowerId}) listening on http://localhost:${config.port} ` +
      `(locus mode: ${config.locusOfflineMode ? "offline/mock" : "live/beta"})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
