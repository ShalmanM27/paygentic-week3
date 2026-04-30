// Phase X2 acceptance test — escrow task flow.
//
// Boots credit-agent + 2 borrower agents (summarizer, code-reviewer) in one
// process, then drives 4 scenarios end-to-end against the mock Locus client:
//
//   1. Happy path — sufficient balance, task RELEASED to agent.
//   2. Borrow mid-task — insufficient balance, loan funded with linkedTaskId,
//      task delivered + RELEASED, then collection-loop repays.
//   3. Verification failure — MOCK_REFUSE=1 makes do-work emit a refusal,
//      verifier rejects, task FAILED → REFUNDED to payer.
//   4. Session expiry — payer never pays, escrow-watcher sees EXPIRED,
//      task EXPIRED.
//
// Reuses the same boot/teardown pattern as test-e2e-loop.ts.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

// Sped-up env BEFORE imports.
process.env.LOCUS_OFFLINE_MODE = "1";
process.env.PORT = "4199";
// Override publicBaseUrl so dispatch's callback URL points at THIS test
// instance (the .env value targets the demo port 4000).
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4199";
process.env.COLLECTION_LOOP_INTERVAL_SECONDS = "2";
process.env.SCORE_LOOP_INTERVAL_SECONDS = "5";
process.env.DEFAULT_LOOP_INTERVAL_SECONDS = "5";
process.env.SETTLEMENT_WATCHER_INTERVAL_SECONDS = "2";
process.env.DEFAULT_GRACE_SECONDS = "10";
process.env.REPAYMENT_FIRST_ATTEMPT_DELAY_SECONDS = "1";
process.env.MAX_REPAYMENT_ATTEMPTS = "2";
process.env.REPAYMENT_BACKOFF_SECONDS = "2,4";
process.env.LOOPS_DISABLED = "0";

const ORIG_URI = process.env.MONGODB_URI ?? "";
process.env.MONGODB_URI = ORIG_URI.replace(/\/credit(\?|$)/, "/credit_test$1");

const {
  BorrowerModel,
  CounterModel,
  LoanModel,
  RepaymentQueueModel,
  ScoreEventModel,
  ScoreReportModel,
  TaskModel,
  TransactionModel,
  MockLocusClient,
  setMockBalanceForKey,
  markMockSessionExpired,
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
const { startEscrowWatcher } = await import("../src/jobs/escrow-watcher.js");
const { _resetBus, subscribe } = await import("../src/lib/sse-bus.js");
const { _resetDefaultedCache } = await import("../src/lib/default-loan.js");

const { buildBorrowerServer, registerWithCredit, _resetJobStore } =
  await import("../../borrower/src/index.js");

const CREDIT_PORT = 4199;
const SUMMARIZER_PORT = 4201;
const REVIEWER_PORT = 4202;

// Wallet keys / secrets.
const SUMMARIZER_KEY = "claw_test_taskflow_sum";
const SUMMARIZER_SECRET = "whsec_test_taskflow_sum";
const REVIEWER_KEY = "claw_test_taskflow_rev";
const REVIEWER_SECRET = "whsec_test_taskflow_rev";
const PAYER_KEY = "claw_test_taskflow_payer";

const SUMMARIZER_ID = "summarizer";
const REVIEWER_ID = "code-reviewer";

// Each agent's pricingUsdc per the registry.
const AGENT_PRICING = 0.008;

function step(label: string): void {
  console.log("");
  console.log(`── ${label} ──`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function http(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
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
  pollMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Poll-and-assert helper: SSE events can land a tick after the DB write
 *  that triggered them, so assertions need to tolerate that lag. */
async function assertSseSoon(
  sseEvents: any[],
  predicate: (e: any) => boolean,
  msg: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sseEvents.some(predicate)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  console.log("test-task-flow — Phase X2 escrow acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect Mongo, clear collections, reset all in-memory state");
  const cfg = loadConfig();
  await connect(cfg.mongoUri);
  await Promise.all([
    BorrowerModel.deleteMany({}),
    CounterModel.deleteMany({}),
    LoanModel.deleteMany({}),
    RepaymentQueueModel.deleteMany({}),
    ScoreEventModel.deleteMany({}),
    ScoreReportModel.deleteMany({}),
    TaskModel.deleteMany({}),
    TransactionModel.deleteMany({}),
  ]);
  _resetMockState();
  _resetBus();
  _resetDefaultedCache();
  _resetJobStore();

  step("subscribe to SSE bus");
  const sseEvents: any[] = [];
  const unsub = subscribe((e: any) => sseEvents.push(e));

  step("boot credit-agent + loops (incl. escrow-watcher)");
  initLocusClient(cfg);
  const credit = await buildCreditServer(cfg);
  await credit.listen({ port: CREDIT_PORT, host: "127.0.0.1" });
  const collection = startCollectionLoop({ logger: credit.log, config: cfg });
  const score = startScoreRecomputeLoop({ logger: credit.log, config: cfg });
  const defaults = startDefaultLoop({ logger: credit.log, config: cfg });
  const settlement = startSettlementWatcher({ logger: credit.log, config: cfg });
  const escrow = startEscrowWatcher({ logger: credit.log, config: cfg });

  step("boot summarizer (high balance — sufficient)");
  const summarizerConfig = {
    port: SUMMARIZER_PORT,
    agentId: SUMMARIZER_ID,
    agentName: "Summarizer",
    agentDescription: "test",
    geminiModel: "gemini-1.5-flash",
    geminiApiKey: "",
    geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
    systemPrompt: "test prompt",
    locusApiKey: SUMMARIZER_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: SUMMARIZER_SECRET,
    locusOfflineMode: true,
    workPrice: 0.005,
    workCost: 0.008,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const summarizer = await buildBorrowerServer(summarizerConfig);
  await summarizer.app.listen({ port: SUMMARIZER_PORT, host: "127.0.0.1" });

  step("boot code-reviewer (low balance — must borrow)");
  const reviewerConfig = {
    port: REVIEWER_PORT,
    agentId: REVIEWER_ID,
    agentName: "Code Reviewer",
    agentDescription: "test",
    geminiModel: "gemini-1.5-flash",
    geminiApiKey: "",
    geminiApiBase: "https://generativelanguage.googleapis.com/v1beta",
    systemPrompt: "test prompt",
    locusApiKey: REVIEWER_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: REVIEWER_SECRET,
    locusOfflineMode: true,
    workPrice: 0.001,
    workCost: 0.008,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const reviewer = await buildBorrowerServer(reviewerConfig);
  await reviewer.app.listen({ port: REVIEWER_PORT, host: "127.0.0.1" });

  step("seed mock balances");
  // summarizer has plenty (no borrow needed for happy path)
  setMockBalanceForKey(SUMMARIZER_KEY, "1.0000");
  // reviewer is broke (must borrow)
  setMockBalanceForKey(REVIEWER_KEY, "0.0001");
  // payer has enough for several escrows
  setMockBalanceForKey(PAYER_KEY, "0.5000");

  step("register both borrowers with credit");
  await registerWithCredit(summarizerConfig, summarizer.locus, summarizer.credit);
  await registerWithCredit(reviewerConfig, reviewer.locus, reviewer.credit);

  step("bump credit limits — summarizer 0.05, reviewer 0.05");
  await BorrowerModel.updateOne(
    { borrowerId: SUMMARIZER_ID },
    { $set: { limit: 0.05, score: 700 } },
  );
  await BorrowerModel.updateOne(
    { borrowerId: REVIEWER_ID },
    { $set: { limit: 0.05, score: 600 } },
  );

  // Payer is a MockLocusClient whose key has a tracked balance — it can
  // call agentPay against any session created by the credit-agent (the
  // mock's session registry is module-level, so all clients share it).
  const payer = new MockLocusClient({ apiKey: PAYER_KEY });

  try {
    // ════════════════════════════════════════════════════════════════════
    step("TEST 1 — happy path (sufficient balance, RELEASED)");
    // ════════════════════════════════════════════════════════════════════
    const t1 = await http(`http://localhost:${CREDIT_PORT}/tasks`, {
      method: "POST",
      body: {
        agentId: SUMMARIZER_ID,
        input: "Summarize the history of zero-knowledge proofs in three bullet points.",
        userIdentifier: "test-user-1",
      },
    });
    assert(t1.status === 200, `T1 create task status ${t1.status} (${JSON.stringify(t1.json)})`);
    const t1TaskId = t1.json.task.taskId as string;
    const t1SessionId = t1.json.sessionId as string;
    console.log("T1 task created:", t1TaskId, "session:", t1SessionId);

    // Payer pays the escrow session.
    await payer.agentPay(t1SessionId);
    console.log("T1 escrow paid by payer");

    // Wait for RELEASED.
    const t1Released = await waitFor(async () => {
      const row = await TaskModel.findOne({ taskId: t1TaskId }).lean();
      return row?.status === "RELEASED" ? row : null;
    }, 20_000);
    console.log("T1 task RELEASED:", {
      status: t1Released.status,
      borrowed: t1Released.borrowedToFulfill,
      releaseTx: t1Released.escrowReleaseTxHash,
      verification: t1Released.verificationNotes,
    });
    assert(t1Released.status === "RELEASED", "T1 status should be RELEASED");
    assert(t1Released.borrowedToFulfill === false, "T1 should NOT borrow (sufficient balance)");
    assert(t1Released.output != null && t1Released.output.length > 0, "T1 output present");
    assert(t1Released.escrowReleaseTxHash != null, "T1 release tx hash present");
    assert(t1Released.payerWalletAddress != null, "T1 payer wallet captured");

    // SSE assertions — tolerate a small publish lag.
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.created" && e.taskId === t1TaskId,
      "T1 SSE task.created",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.escrow_paid" && e.taskId === t1TaskId,
      "T1 SSE task.escrow_paid",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.dispatched" && e.taskId === t1TaskId,
      "T1 SSE task.dispatched",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.delivered" && e.taskId === t1TaskId,
      "T1 SSE task.delivered",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.released" && e.taskId === t1TaskId,
      "T1 SSE task.released",
    );
    console.log("✓ TEST 1 PASSED");

    // ════════════════════════════════════════════════════════════════════
    step("TEST 2 — borrow mid-task (insufficient balance → loan funded)");
    // ════════════════════════════════════════════════════════════════════
    const t2 = await http(`http://localhost:${CREDIT_PORT}/tasks`, {
      method: "POST",
      body: {
        agentId: REVIEWER_ID,
        input: "Review this code: function add(a, b) { return a + b; }",
        userIdentifier: "test-user-2",
      },
    });
    assert(t2.status === 200, `T2 create task status ${t2.status}`);
    const t2TaskId = t2.json.task.taskId as string;
    const t2SessionId = t2.json.sessionId as string;
    console.log("T2 task created:", t2TaskId);

    await payer.agentPay(t2SessionId);
    console.log("T2 escrow paid by payer");

    const t2Released = await waitFor(async () => {
      const row = await TaskModel.findOne({ taskId: t2TaskId }).lean();
      return row?.status === "RELEASED" ? row : null;
    }, 20_000);
    console.log("T2 task RELEASED:", {
      status: t2Released.status,
      borrowed: t2Released.borrowedToFulfill,
      loanId: t2Released.loanId,
    });
    assert(t2Released.status === "RELEASED", "T2 status should be RELEASED");
    assert(t2Released.borrowedToFulfill === true, "T2 should borrow (insufficient balance)");
    assert(t2Released.loanId != null, "T2 loanId should be set");

    const t2Loan = await LoanModel.findOne({ loanId: t2Released.loanId });
    assert(t2Loan, "T2 loan row exists");
    assert(t2Loan.linkedTaskId === t2TaskId, `T2 loan.linkedTaskId=${t2Loan.linkedTaskId} != ${t2TaskId}`);
    console.log("T2 loan:", { loanId: t2Loan.loanId, status: t2Loan.status, linkedTaskId: t2Loan.linkedTaskId });

    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.borrowing" && e.taskId === t2TaskId,
      "T2 SSE task.borrowing",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.borrowed" && e.taskId === t2TaskId,
      "T2 SSE task.borrowed",
    );
    console.log("✓ TEST 2 PASSED");

    // ════════════════════════════════════════════════════════════════════
    step("TEST 3 — verification failure (MOCK_REFUSE=1 → REFUNDED)");
    // ════════════════════════════════════════════════════════════════════
    process.env.MOCK_REFUSE = "1";
    try {
      const t3 = await http(`http://localhost:${CREDIT_PORT}/tasks`, {
        method: "POST",
        body: {
          agentId: SUMMARIZER_ID,
          input: "Please refuse this task to test the verifier's refusal-pattern check.",
          userIdentifier: "test-user-3",
        },
      });
      assert(t3.status === 200, `T3 create task status ${t3.status}`);
      const t3TaskId = t3.json.task.taskId as string;
      const t3SessionId = t3.json.sessionId as string;
      console.log("T3 task created:", t3TaskId);

      await payer.agentPay(t3SessionId);
      console.log("T3 escrow paid by payer");

      const t3Refunded = await waitFor(async () => {
        const row = await TaskModel.findOne({ taskId: t3TaskId }).lean();
        return row?.status === "REFUNDED" ? row : null;
      }, 20_000);
      console.log("T3 task REFUNDED:", {
        status: t3Refunded.status,
        verificationNotes: t3Refunded.verificationNotes,
        refundTx: t3Refunded.escrowRefundTxHash,
      });
      assert(t3Refunded.status === "REFUNDED", "T3 status should be REFUNDED");
      assert(
        t3Refunded.verificationNotes != null &&
          t3Refunded.verificationNotes.includes("refusal"),
        "T3 verification notes mention refusal",
      );

      await assertSseSoon(
        sseEvents,
        (e) => e.kind === "task.failed" && e.taskId === t3TaskId,
        "T3 SSE task.failed",
      );
      await assertSseSoon(
        sseEvents,
        (e) => e.kind === "task.refunded" && e.taskId === t3TaskId,
        "T3 SSE task.refunded",
      );
      console.log("✓ TEST 3 PASSED");
    } finally {
      delete process.env.MOCK_REFUSE;
    }

    // ════════════════════════════════════════════════════════════════════
    step("TEST 4 — session expiry (escrow-watcher → EXPIRED)");
    // ════════════════════════════════════════════════════════════════════
    const t4 = await http(`http://localhost:${CREDIT_PORT}/tasks`, {
      method: "POST",
      body: {
        agentId: SUMMARIZER_ID,
        input: "This task's escrow will be left unpaid until expiry.",
        userIdentifier: "test-user-4",
      },
    });
    assert(t4.status === 200, `T4 create task status ${t4.status}`);
    const t4TaskId = t4.json.task.taskId as string;
    const t4SessionId = t4.json.sessionId as string;
    console.log("T4 task created:", t4TaskId);

    // Force the mock session to EXPIRED — escrow-watcher should pick it up.
    const expired = markMockSessionExpired(t4SessionId);
    assert(expired, "T4 session expiry marker should succeed");
    console.log("T4 escrow session marked EXPIRED");

    const t4Expired = await waitFor(async () => {
      const row = await TaskModel.findOne({ taskId: t4TaskId }).lean();
      return row?.status === "EXPIRED" ? row : null;
    }, 20_000);
    console.log("T4 task EXPIRED:", {
      status: t4Expired.status,
      escrowSessionStatus: t4Expired.escrowSessionStatus,
    });
    assert(t4Expired.status === "EXPIRED", "T4 status should be EXPIRED");
    assert(
      t4Expired.escrowSessionStatus === "EXPIRED",
      "T4 escrowSessionStatus should be EXPIRED",
    );

    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "task.expired" && e.taskId === t4TaskId,
      "T4 SSE task.expired",
    );
    console.log("✓ TEST 4 PASSED");

    console.log("");
    console.log("════════════════════════════════════════");
    console.log("✓ ALL 4 TASK-FLOW TESTS PASSED");
    console.log("════════════════════════════════════════");
  } finally {
    step("teardown");
    unsub();
    collection.stop();
    score.stop();
    defaults.stop();
    settlement.stop();
    escrow.stop();
    await summarizer.app.close();
    await reviewer.app.close();
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
