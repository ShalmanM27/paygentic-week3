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
  process.env.REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS ?? "3";
process.env.MAX_REPAYMENT_ATTEMPTS =
  process.env.MAX_REPAYMENT_ATTEMPTS ?? "2";
process.env.REPAYMENT_BACKOFF_SECONDS =
  process.env.REPAYMENT_BACKOFF_SECONDS ?? "3,6";

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

const { buildBorrowerServer, registerWithCredit } = await import(
  "../../borrower/src/index.js"
);

const { buildServer: buildCustomerServer } = await import(
  "../../customer-agent/src/server.js"
);

const CREDIT_PORT = 4000;
const BORROWER_A_PORT = 4001;
const BORROWER_B_PORT = 4002;
const CUSTOMER_PORT = 4003;

const BORROWER_A_KEY = "claw_dev_demo_a";
const BORROWER_A_SECRET = "whsec_demo_a";
const BORROWER_B_KEY = "claw_dev_demo_b";
const BORROWER_B_SECRET = "whsec_demo_b";
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
  console.log(
    `    loops: collection=${cfg.collectionLoopIntervalSeconds}s · score=${cfg.scoreLoopIntervalSeconds}s · default=${cfg.defaultLoopIntervalSeconds}s`,
  );

  // ── borrower-a ──────────────────────────────────────────────────────
  const borrowerAConfig = {
    port: BORROWER_A_PORT,
    borrowerId: "agent-a",
    locusApiKey: BORROWER_A_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: BORROWER_A_SECRET,
    locusOfflineMode: true,
    workPrice: 0.005,
    workCost: 0.008,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const borrowerA = await buildBorrowerServer(borrowerAConfig);
  await borrowerA.app.listen({ port: BORROWER_A_PORT, host: "0.0.0.0" });
  await registerWithCredit(borrowerAConfig, borrowerA.locus, borrowerA.credit);
  console.log(`  ✓ borrower-a    → http://localhost:${BORROWER_A_PORT}`);

  // ── borrower-b ──────────────────────────────────────────────────────
  const borrowerBConfig = {
    port: BORROWER_B_PORT,
    borrowerId: "agent-b",
    locusApiKey: BORROWER_B_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: BORROWER_B_SECRET,
    locusOfflineMode: true,
    // Loss-leader pricing: customer pays $0.001 but work costs $0.008.
    // Borrower MUST borrow heavily; after work-cost drain, balance is
    // below repayAmount — forces a default. The deadbeat's economics.
    workPrice: 0.001,
    workCost: 0.008,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const borrowerB = await buildBorrowerServer(borrowerBConfig);
  await borrowerB.app.listen({ port: BORROWER_B_PORT, host: "0.0.0.0" });
  await registerWithCredit(borrowerBConfig, borrowerB.locus, borrowerB.credit);
  console.log(`  ✓ borrower-b    → http://localhost:${BORROWER_B_PORT}`);

  // ── customer-agent ──────────────────────────────────────────────────
  const customerConfig = {
    port: CUSTOMER_PORT,
    locusApiKey: CUSTOMER_KEY,
    locusApiBase: cfg.locusApiBase,
    locusOfflineMode: true,
    borrowerAUrl: `http://localhost:${BORROWER_A_PORT}`,
    borrowerBUrl: `http://localhost:${BORROWER_B_PORT}`,
    continuousMode: false,
    jobIntervalSeconds: 20,
    borrowerWeightA: 0.7,
  };
  const customer = await buildCustomerServer(customerConfig);
  await customer.app.listen({ port: CUSTOMER_PORT, host: "0.0.0.0" });
  console.log(`  ✓ customer-agent → http://localhost:${CUSTOMER_PORT}`);

  // ── canonical demo seed (single source of truth — see demo-seed.ts) ─
  const seedResult = await applyDemoSeed(cfg);
  console.log("\n  ✓ seeded:", seedResult.borrowersReset.join(", "));
  console.log(`    customer wallet: $0.5000`);
  console.log(`    borrower-a:      $0.0010 / score 750 / limit $0.05`);
  console.log(`    borrower-b:      $0.0010 / score 550 / limit $0.02`);
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
      await borrowerA.app.close();
      await borrowerB.app.close();
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
