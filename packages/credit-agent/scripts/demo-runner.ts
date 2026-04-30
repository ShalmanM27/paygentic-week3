// Single-process demo runner. Boots all four backends in ONE Node process
// so the offline-mock LocusClient state is shared across services. Without
// this, `pnpm dev:all` (which uses `concurrently`) spawns 4 isolated
// processes and the mock session registry is per-process — cross-agent
// agentPay calls fail with "session not found".
//
// Run from repo root:  pnpm demo
//
// In live mode this would not be necessary — Locus is the shared store.
// For the offline demo, this is the canonical entry point.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

// Force offline + fast loops + debug routes regardless of .env values.
process.env.LOCUS_OFFLINE_MODE = "1";
process.env.PORT = "4000";
process.env.LOOPS_DISABLED = "0";
process.env.DEBUG_ENDPOINTS_ENABLED = "1";
process.env.COLLECTION_LOOP_INTERVAL_SECONDS =
  process.env.COLLECTION_LOOP_INTERVAL_SECONDS ?? "3";
process.env.SCORE_LOOP_INTERVAL_SECONDS =
  process.env.SCORE_LOOP_INTERVAL_SECONDS ?? "5";
process.env.DEFAULT_LOOP_INTERVAL_SECONDS =
  process.env.DEFAULT_LOOP_INTERVAL_SECONDS ?? "5";
process.env.DEFAULT_GRACE_SECONDS = process.env.DEFAULT_GRACE_SECONDS ?? "10";
process.env.REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS =
  process.env.REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS ?? "2";
// Demo cadence: 1 attempt only, no backoff. Default fires within
// ~3-4s of loan funding for a snappy default-path demo.
process.env.MAX_REPAYMENT_ATTEMPTS =
  process.env.MAX_REPAYMENT_ATTEMPTS ?? "1";
process.env.REPAYMENT_BACKOFF_SECONDS =
  process.env.REPAYMENT_BACKOFF_SECONDS ?? "2";

const { connect, disconnect } = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
const { applyDemoSeed, DEMO_CUSTOMER_KEY } = await import(
  "../src/lib/demo-seed.js"
);
const { initLocusClient } = await import("../src/lib/locus.js");
const { buildServer: buildCreditServer } = await import("../src/server.js");
const { startCollectionLoop } = await import("../src/jobs/collection-loop.js");
const { startScoreRecomputeLoop } = await import(
  "../src/jobs/score-recompute-loop.js"
);
const { startDefaultLoop } = await import("../src/jobs/default-loop.js");
const { startSettlementWatcher } = await import(
  "../src/jobs/settlement-watcher.js"
);
const { startEscrowWatcher } = await import("../src/jobs/escrow-watcher.js");
const { startSubscriptionWatcher } = await import(
  "../src/jobs/subscription-watcher.js"
);

const { buildBorrowerServer, registerWithCredit, systemPromptFor } =
  await import("../../borrower/src/index.js");

const { buildServer: buildCustomerServer } = await import(
  "../../customer-agent/src/server.js"
);

const CREDIT_PORT = 4000;
const SUMMARIZER_PORT = 4001;
const REVIEWER_PORT = 4002;
const CUSTOMER_PORT = 4003;
const WRITER_PORT = 4004;

// summarizer + writer SHARE one wallet (one Locus account hosts two agents).
// reviewer has its own.
const SHARED_WALLET_KEY = "claw_dev_demo_a";
const SHARED_WALLET_SECRET = "whsec_demo_a";
const REVIEWER_KEY = "claw_dev_demo_b";
const REVIEWER_SECRET = "whsec_demo_b";
// Customer demo key is canonicalized in demo-seed.ts as DEMO_CUSTOMER_KEY.
const CUSTOMER_KEY = DEMO_CUSTOMER_KEY;

async function main(): Promise<void> {
  console.log("\n┌─────────────────────────────────────────────┐");
  console.log("│   CREDIT — single-process demo runner       │");
  console.log("│   (offline mock; all 4 services in one PID) │");
  console.log("└─────────────────────────────────────────────┘\n");

  const cfg = loadConfig();
  console.log(`mongo: ${cfg.mongoUri.replace(/:[^:@]+@/, ":***@")}`);
  await connect(cfg.mongoUri);

  // Sync schema-defined indexes — important after the X1 rename which
  // dropped walletAddress's unique constraint (multiple agents share
  // wallets). Without this, the DB-side unique index lingers and blocks
  // registration of the second agent on a shared wallet.
  const { BorrowerModel, AgentModel, AgentSubscriptionModel } = await import(
    "@credit/shared"
  );
  await BorrowerModel.syncIndexes();

  // Clean slate on every demo boot:
  // - operator-registered agents and all subscriptions wiped so the grid
  //   starts tidy
  // - tasks wiped so the mock session ID counter (resets to 1 on boot)
  //   doesn't collide with stale tasks' unique escrowSessionId index
  const { TaskModel } = await import("@credit/shared");
  await Promise.all([
    AgentModel.deleteMany({ isBuiltIn: { $ne: true } }),
    AgentSubscriptionModel.deleteMany({}),
    TaskModel.deleteMany({}),
  ]);

  // Pre-registration mock balances (so /work's first balance() call
  // sees a tracked value). Final canonical seeding happens via
  // applyDemoSeed() below, after both borrowers register.

  // ── credit-agent ────────────────────────────────────────────────────
  initLocusClient(cfg);
  const credit = await buildCreditServer(cfg);
  await credit.listen({ port: CREDIT_PORT, host: "0.0.0.0" });
  console.log(`  ✓ credit-agent  → http://localhost:${CREDIT_PORT}`);

  const collection = startCollectionLoop({ logger: credit.log, config: cfg });
  const score = startScoreRecomputeLoop({ logger: credit.log, config: cfg });
  const defaults = startDefaultLoop({ logger: credit.log, config: cfg });
  const settlement = startSettlementWatcher({ logger: credit.log, config: cfg });
  const escrow = startEscrowWatcher({ logger: credit.log, config: cfg });
  const subscription = startSubscriptionWatcher({
    logger: credit.log,
    config: cfg,
  });
  console.log(
    `    loops: collection=${cfg.collectionLoopIntervalSeconds}s · score=${cfg.scoreLoopIntervalSeconds}s · default=${cfg.defaultLoopIntervalSeconds}s · escrow=3s · subscription=${cfg.subscriptionWatcherIntervalSeconds}s`,
  );

  const sharedAgentBase = {
    locusApiBase: cfg.locusApiBase,
    locusOfflineMode: true,
    workPrice: 0.005,
    workCost: 0.008,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
    geminiModel: "gemini-1.5-flash",
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiApiBase:
      process.env.GEMINI_API_BASE ??
      "https://generativelanguage.googleapis.com/v1beta",
  };

  // ── agent-summarizer ────────────────────────────────────────────────
  const summarizerConfig = {
    ...sharedAgentBase,
    port: SUMMARIZER_PORT,
    agentId: "summarizer",
    agentName: "Summarizer",
    agentDescription: "Summarizes long documents into concise notes",
    systemPrompt: systemPromptFor("summarizer"),
    locusApiKey: SHARED_WALLET_KEY,
    locusWebhookSecret: SHARED_WALLET_SECRET,
  };
  const summarizer = await buildBorrowerServer(summarizerConfig);
  await summarizer.app.listen({ port: SUMMARIZER_PORT, host: "0.0.0.0" });
  await registerWithCredit(summarizerConfig, summarizer.locus, summarizer.credit);
  console.log(`  ✓ summarizer     → http://localhost:${SUMMARIZER_PORT}`);

  // ── agent-code-reviewer (loss-leader pricing → reliable defaults) ──
  const reviewerConfig = {
    ...sharedAgentBase,
    port: REVIEWER_PORT,
    agentId: "code-reviewer",
    agentName: "Code Reviewer",
    agentDescription: "Reviews code for bugs, style, and security issues",
    systemPrompt: systemPromptFor("code-reviewer"),
    locusApiKey: REVIEWER_KEY,
    locusWebhookSecret: REVIEWER_SECRET,
    // Loss-leader: low revenue → forces borrowing → drained balance →
    // default. Same dynamic the old borrower-b had.
    workPrice: 0.001,
  };
  const reviewer = await buildBorrowerServer(reviewerConfig);
  await reviewer.app.listen({ port: REVIEWER_PORT, host: "0.0.0.0" });
  await registerWithCredit(reviewerConfig, reviewer.locus, reviewer.credit);
  console.log(`  ✓ code-reviewer  → http://localhost:${REVIEWER_PORT}`);

  // ── agent-code-writer (shares wallet with summarizer) ──────────────
  const writerConfig = {
    ...sharedAgentBase,
    port: WRITER_PORT,
    agentId: "code-writer",
    agentName: "Code Writer",
    agentDescription: "Generates code from natural language specifications",
    systemPrompt: systemPromptFor("code-writer"),
    locusApiKey: SHARED_WALLET_KEY,
    locusWebhookSecret: SHARED_WALLET_SECRET,
  };
  const writer = await buildBorrowerServer(writerConfig);
  await writer.app.listen({ port: WRITER_PORT, host: "0.0.0.0" });
  await registerWithCredit(writerConfig, writer.locus, writer.credit);
  console.log(`  ✓ code-writer    → http://localhost:${WRITER_PORT} (shares wallet w/ summarizer)`);

  // ── customer-agent (legacy demo trigger) ────────────────────────────
  const customerConfig = {
    port: CUSTOMER_PORT,
    locusApiKey: CUSTOMER_KEY,
    locusApiBase: cfg.locusApiBase,
    locusOfflineMode: true,
    borrowerAUrl: `http://localhost:${SUMMARIZER_PORT}`,
    borrowerBUrl: `http://localhost:${REVIEWER_PORT}`,
    continuousMode: false,
    jobIntervalSeconds: 20,
    borrowerWeightA: 0.7,
  };
  const customer = await buildCustomerServer(customerConfig);
  await customer.app.listen({ port: CUSTOMER_PORT, host: "0.0.0.0" });
  console.log(`  ✓ customer-agent → http://localhost:${CUSTOMER_PORT}`);

  // ── canonical demo seed (single source of truth — see demo-seed.ts) ─
  const seedResult = await applyDemoSeed(cfg);

  // V2 safety net: every agent on the marketplace must show "Available"
  // for the demo. Force isActive=true regardless of subscription state.
  await AgentModel.updateMany({}, { $set: { isActive: true } });
  console.log("\n  ✓ seeded:", seedResult.borrowersReset.join(", "));
  console.log(`    customer wallet:  $0.5000`);
  console.log(`    summarizer:       $0.0010 / score 750 / limit $0.05  (shared wallet)`);
  console.log(`    code-reviewer:    $0.0010 / score 550 / limit $0.02`);
  console.log(`    code-writer:      $0.0010 / score 700 / limit $0.04  (shared wallet)`);
  console.log("\nReady. Open http://localhost:3000/flow and click [Run Loan].\n");
  console.log("Ctrl+C to shut down all services.\n");

  // ── Shutdown ────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] shutting down…`);
    try {
      collection.stop();
      score.stop();
      defaults.stop();
      settlement.stop();
      escrow.stop();
      subscription.stop();
      await summarizer.app.close();
      await reviewer.app.close();
      await writer.app.close();
      await customer.app.close();
      await credit.close();
      await disconnect();
    } catch (err) {
      console.error("shutdown error:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
