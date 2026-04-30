// Phase 7 — full system end-to-end in mock mode.
//
// Boots all four services in one process:
//   credit-agent  :4099  (with all loops on, fast intervals)
//   borrower-a    :4101
//   borrower-b    :4102
//   customer      :4103
//
// Asserts one full cycle: customer → borrower-a /work → 402 → customer
// agentPay → (synthesize webhook to borrower) → borrower processJob →
// /credit/draw → /credit/fund → loan FUNDED → collection-loop ticks →
// borrower agentPays repayment session → handleRepaymentPaid → loan REPAID.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

// Sped-up env BEFORE imports.
process.env.LOCUS_OFFLINE_MODE = "1";
process.env.PORT = "4099";
process.env.COLLECTION_LOOP_INTERVAL_SECONDS = "2";
process.env.SCORE_LOOP_INTERVAL_SECONDS = "2";
process.env.DEFAULT_LOOP_INTERVAL_SECONDS = "2";
process.env.SETTLEMENT_WATCHER_INTERVAL_SECONDS = "2";
process.env.DEFAULT_GRACE_SECONDS = "2";
process.env.REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS = "1";
process.env.MAX_REPAYMENT_ATTEMPTS = "2";
process.env.REPAYMENT_BACKOFF_SECONDS = "2,4";
process.env.LOOPS_DISABLED = "0";

const ORIG_URI = process.env.MONGODB_URI ?? "";
process.env.MONGODB_URI = ORIG_URI.replace(/\/credit(\?|$)/, "/credit_test$1");

const {
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  ScoreEventModel,
  ScoreReportModel,
  TransactionModel,
  setMockBalanceForKey,
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
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
const { _resetBus, subscribe } = await import("../src/lib/sse-bus.js");
const { _resetDefaultedCache } = await import("../src/lib/default-loan.js");

const {
  buildBorrowerServer,
  registerWithCredit,
  _resetJobStore,
} = await import("../../borrower/src/index.js");

const { buildServer: buildCustomerServer } = await import(
  "../../customer-agent/src/server.js"
);

const { postSignedWebhook } = await import(
  "./_test-helpers/sign-webhook.js"
);

const CREDIT_PORT = 4099;
const BORROWER_A_PORT = 4101;
const BORROWER_B_PORT = 4102;
const CUSTOMER_PORT = 4103;

const BORROWER_A_ID = "agent-a";
const BORROWER_A_KEY = "claw_dev_test_e2e_a";
const BORROWER_A_WEBHOOK_SECRET =
  "whsec_test_e2e_a_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

const BORROWER_B_ID = "agent-b";
const BORROWER_B_KEY = "claw_dev_test_e2e_b";
const BORROWER_B_WEBHOOK_SECRET =
  "whsec_test_e2e_b_d6c5b4a3e1f2c9d0b8a7f6e5d4c3b2a1";

const CUSTOMER_KEY = "claw_dev_test_e2e_customer";

// Borrower-a economics (loss-leader for the demo: workCost > workPrice
// so the borrower MUST borrow each cycle, exercising the credit path).
const A_WORK_PRICE = 0.005;
const A_WORK_COST = 0.008;
const A_SAFETY = 0.001;

function step(label: string): void {
  console.log("");
  console.log(`── ${label} ──`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function http(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = { _nonjson: text };
  }
  return { status: res.status, json };
}
async function waitFor<T>(
  predicate: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs: number,
  pollMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  console.log("test-e2e-loop — Phase 7 acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect Mongo, clear collections, reset all in-memory state");
  const cfg = loadConfig();
  await connect(cfg.mongoUri);
  await Promise.all([
    BorrowerModel.deleteMany({}),
    LoanModel.deleteMany({}),
    RepaymentQueueModel.deleteMany({}),
    ScoreEventModel.deleteMany({}),
    ScoreReportModel.deleteMany({}),
    TransactionModel.deleteMany({}),
  ]);
  _resetMockState();
  _resetBus();
  _resetDefaultedCache();
  _resetJobStore();

  step("seed mock wallet balances");
  setMockBalanceForKey(BORROWER_A_KEY, "0.0010");
  setMockBalanceForKey(BORROWER_B_KEY, "0.0010");
  setMockBalanceForKey(CUSTOMER_KEY, "0.0500");

  step("subscribe to SSE bus");
  const sseEvents: any[] = [];
  const unsub = subscribe((e: any) => sseEvents.push(e));

  step("boot credit-agent");
  initLocusClient(cfg);
  const credit = await buildCreditServer(cfg);
  await credit.listen({ port: CREDIT_PORT, host: "127.0.0.1" });
  const collection = startCollectionLoop({ logger: credit.log, config: cfg });
  const score = startScoreRecomputeLoop({ logger: credit.log, config: cfg });
  const defaults = startDefaultLoop({ logger: credit.log, config: cfg });
  const settlement = startSettlementWatcher({ logger: credit.log, config: cfg });

  step("boot borrower-a");
  const borrowerAConfig = {
    port: BORROWER_A_PORT,
    agentId: BORROWER_A_ID,
    agentName: "TestAgentA",
    agentDescription: "test",
    geminiModel: "gemini-1.5-flash",
    geminiApiKey: "",
    geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
    systemPrompt: "test prompt",
    locusApiKey: BORROWER_A_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: BORROWER_A_WEBHOOK_SECRET,
    locusOfflineMode: true,
    workPrice: A_WORK_PRICE,
    workCost: A_WORK_COST,
    safetyBuffer: A_SAFETY,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const borrowerA = await buildBorrowerServer(borrowerAConfig);
  await borrowerA.app.listen({ port: BORROWER_A_PORT, host: "127.0.0.1" });

  step("boot borrower-b");
  const borrowerBConfig = {
    port: BORROWER_B_PORT,
    agentId: BORROWER_B_ID,
    agentName: "TestAgentB",
    agentDescription: "test",
    geminiModel: "gemini-1.5-flash",
    geminiApiKey: "",
    geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
    systemPrompt: "test prompt",
    locusApiKey: BORROWER_B_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: BORROWER_B_WEBHOOK_SECRET,
    locusOfflineMode: true,
    workPrice: 0.005,
    workCost: 0.005,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const borrowerB = await buildBorrowerServer(borrowerBConfig);
  await borrowerB.app.listen({ port: BORROWER_B_PORT, host: "127.0.0.1" });

  step("boot customer-agent");
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
  await customer.app.listen({ port: CUSTOMER_PORT, host: "127.0.0.1" });

  step("register both borrowers with credit");
  await registerWithCredit(borrowerAConfig, borrowerA.locus, borrowerA.credit);
  await registerWithCredit(borrowerBConfig, borrowerB.locus, borrowerB.credit);

  step("bump borrower-a limit to 0.05 in Mongo");
  await BorrowerModel.updateOne(
    { borrowerId: BORROWER_A_ID },
    { $set: { limit: 0.05 } },
  );

  try {
    step("POST /trigger to customer-agent (borrowerId=agent-a)");
    const trig = await http(`http://localhost:${CUSTOMER_PORT}/trigger`, {
      method: "POST",
      body: { borrowerId: "agent-a", url: "https://example.com/article" },
    });
    console.log("→", trig.status, trig.json);
    assert(trig.status === 200, `trigger status ${trig.status}`);
    const customerSessionId = trig.json.sessionId as string;
    assert(typeof customerSessionId === "string", "trigger returned sessionId");

    step("synthesize customer→borrower-a webhook (HMAC w/ borrower-a secret)");
    const wh = await postSignedWebhook({
      url: `http://localhost:${BORROWER_A_PORT}/webhooks`,
      envelope: {
        type: "checkout.session.paid",
        data: {
          sessionId: customerSessionId,
          txHash: "0xfake_e2e_customer_pay",
        },
      },
      secret: BORROWER_A_WEBHOOK_SECRET,
    });
    console.log("→", wh.status, wh.json);
    assert(wh.status === 200, `webhook status ${wh.status}`);

    step("await loan FUNDED in Mongo");
    const funded = await waitFor(async () => {
      const l = await LoanModel.findOne({ borrowerId: BORROWER_A_ID });
      return l?.status === "FUNDED" ? l : null;
    }, 8000);
    console.log("→ loan FUNDED:", {
      loanId: funded.loanId,
      amount: funded.amount,
      repayAmount: funded.repayAmount,
      disbursementStatus: funded.disbursementStatus,
    });

    step("await SSE loan.funded");
    const fundedSse = await waitFor(
      () =>
        sseEvents.find(
          (e) => e.kind === "loan.funded" && e.loanId === funded.loanId,
        ),
      3000,
    );
    console.log("✓ SSE loan.funded:", fundedSse.loanId);

    step("await collection-loop → loan REPAID (≤ 12s)");
    const repaid = await waitFor(async () => {
      const l = await LoanModel.findOne({ loanId: funded.loanId });
      return l?.status === "REPAID" ? l : null;
    }, 12000);
    console.log(
      "→ loan REPAID:",
      repaid.loanId,
      "tx:",
      repaid.repaymentTxHash,
    );

    step("await queue.state COMPLETED");
    const queue = await waitFor(async () => {
      const q = await RepaymentQueueModel.findOne({ loanId: funded.loanId });
      return q?.state === "COMPLETED" ? q : null;
    }, 3000);
    console.log("→ queue COMPLETED");

    step("await borrower-a outstanding ≈ 0");
    const borrower = await waitFor(async () => {
      const b = await BorrowerModel.findOne({ borrowerId: BORROWER_A_ID });
      return b && Math.abs(b.outstanding) < 1e-9 ? b : null;
    }, 3000);
    console.log("→ borrower outstanding:", borrower.outstanding);

    step("assert: score_event loan_repaid exists");
    const repaidEvent = await ScoreEventModel.findOne({
      borrowerId: BORROWER_A_ID,
      type: "loan_repaid",
    });
    assert(repaidEvent, "score_event loan_repaid created");

    step("assert: transactions has draw + repayment rows");
    const drawTx = await TransactionModel.findOne({
      loanId: funded.loanId,
      type: "draw",
    });
    assert(drawTx, "draw transaction exists");
    const repayTx = await TransactionModel.findOne({
      loanId: funded.loanId,
      type: "repayment",
    });
    assert(repayTx, "repayment transaction exists");

    step("await SSE loan.repaid");
    const repaidSse = await waitFor(
      () =>
        sseEvents.find(
          (e) => e.kind === "loan.repaid" && e.loanId === funded.loanId,
        ),
      3000,
    );
    console.log("✓ SSE loan.repaid:", repaidSse.loanId);

    console.log("");
    console.log("✓ all e2e assertions passed");
  } finally {
    step("teardown");
    unsub();
    collection.stop();
    score.stop();
    defaults.stop();
    settlement.stop();
    await borrowerA.app.close();
    await borrowerB.app.close();
    await customer.app.close();
    await credit.close();
    await disconnect();
    console.log("all servers closed, db disconnected");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
