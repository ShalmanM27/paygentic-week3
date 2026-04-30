// End-to-end test for Phase 4: background loops.
// Boots the credit-agent server, starts all three loops with shortened
// intervals via env overrides, runs four scenarios, asserts state.

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
  MockLocusClient,
  setMockBalanceForKey,
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
const { initLocusClient } = await import("../src/lib/locus.js");
const { buildServer } = await import("../src/server.js");
const { startCollectionLoop } = await import("../src/jobs/collection-loop.js");
const { startScoreRecomputeLoop } = await import(
  "../src/jobs/score-recompute-loop.js"
);
const { startDefaultLoop } = await import("../src/jobs/default-loop.js");
const { _resetBus, subscribe } = await import("../src/lib/sse-bus.js");
const { _resetDefaultedCache } = await import("../src/lib/default-loan.js");

const BASE = "http://localhost:4099";

function step(label: string): void {
  console.log("");
  console.log(`── ${label} ──`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function fundLoan(args: {
  borrowerId: string;
  apiKey: string;
  wallet: string;
  amount?: number;
  ttl?: number;
}): Promise<{ loanId: string; repayAmount: number }> {
  const reg = await http("POST", "/credit/register", {
    borrowerId: args.borrowerId,
    walletAddress: args.wallet,
    serviceUrl: "http://localhost:4001",
    registrationApiKey: args.apiKey,
  });
  assert(reg.status === 200, `register status ${reg.status}`);
  await BorrowerModel.updateOne(
    { borrowerId: args.borrowerId },
    { $set: { limit: 0.05 } },
  );

  const draw = await http("POST", "/credit/draw", {
    borrowerId: args.borrowerId,
    amount: args.amount ?? 0.005,
    purpose: "wrapped-api/firecrawl-scrape",
    ttl: args.ttl ?? 3600,
  });
  assert(draw.status === 200, `draw status ${draw.status}`);
  const decisionToken = draw.json.decisionToken as string;

  const merchant = new MockLocusClient({
    apiKey: `claw_dev_mock_merchant_${args.borrowerId}`,
    mockBalance: "0",
  });
  const target = await merchant.createSession({
    amount: args.amount ?? 0.005,
    currency: "USDC",
    ttlSeconds: 600,
  });
  const fund = await http("POST", "/credit/fund", {
    decisionToken,
    targetSessionId: target.id,
  });
  assert(fund.status === 200, `fund status ${fund.status}`);
  return {
    loanId: fund.json.loanId,
    repayAmount: fund.json.repayAmount,
  };
}

async function main(): Promise<void> {
  console.log("test-loops — Phase 4 acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

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

  initLocusClient(cfg);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });

  const sseEvents: any[] = [];
  const unsub = subscribe((e: any) => sseEvents.push(e));

  const collection = startCollectionLoop({ logger: app.log, config: cfg });
  const score = startScoreRecomputeLoop({ logger: app.log, config: cfg });
  const defaults = startDefaultLoop({ logger: app.log, config: cfg });

  try {
    // ── SCENARIO 1: collection succeeds ─────────────────────────────
    step("SCENARIO 1: collection succeeds (good borrower)");
    const goodKey = "claw_dev_test_good";
    setMockBalanceForKey(goodKey, "10.00");
    const good = await fundLoan({
      borrowerId: "borrower-good",
      apiKey: goodKey,
      wallet: "0x" + "aa".repeat(20),
    });
    console.log("loanId:", good.loanId, "repayAmount:", good.repayAmount);

    const repaid = await waitFor(async () => {
      const l = await LoanModel.findOne({ loanId: good.loanId });
      return l?.status === "REPAID" ? l : null;
    }, 8000);
    console.log("→ loan REPAID:", repaid.loanId, "tx:", repaid.repaymentTxHash);

    const queueGood = await waitFor(async () => {
      const q = await RepaymentQueueModel.findOne({ loanId: good.loanId });
      return q?.state === "COMPLETED" ? q : null;
    }, 3000);
    assert(queueGood?.state === "COMPLETED", `queue.state=${queueGood?.state}`);
    const borrowerGood = await BorrowerModel.findOne({ borrowerId: "borrower-good" });
    assert(
      Math.abs((borrowerGood?.outstanding ?? 99) - 0) < 1e-9,
      `outstanding=${borrowerGood?.outstanding}`,
    );
    const repaidSse = await waitFor(
      () =>
        sseEvents.find(
          (e) => e.kind === "loan.repaid" && e.loanId === good.loanId,
        ),
      3000,
    );
    assert(repaidSse, "SSE loan.repaid for good loan");
    console.log("✓ scenario 1 passed");

    // ── SCENARIO 2: collection fails → default ──────────────────────
    step("SCENARIO 2: collection fails, defaults after max attempts");
    const badKey = "claw_dev_test_bad";
    setMockBalanceForKey(badKey, "0");
    const bad = await fundLoan({
      borrowerId: "borrower-bad",
      apiKey: badKey,
      wallet: "0x" + "bb".repeat(20),
    });
    console.log("loanId:", bad.loanId);

    const defaulted = await waitFor(async () => {
      const l = await LoanModel.findOne({ loanId: bad.loanId });
      return l?.status === "DEFAULTED" ? l : null;
    }, 15000);
    console.log("→ loan DEFAULTED:", defaulted.loanId);

    const borrowerBad = await BorrowerModel.findOne({ borrowerId: "borrower-bad" });
    assert(
      borrowerBad?.defaultCount === 1,
      `defaultCount=${borrowerBad?.defaultCount}`,
    );
    const defaultedSse = await waitFor(
      () =>
        sseEvents.find(
          (e) =>
            e.kind === "loan.defaulted" &&
            e.loanId === bad.loanId &&
            e.reason === "max_attempts_reached",
        ),
      3000,
    );
    assert(defaultedSse, "SSE loan.defaulted with reason=max_attempts_reached");
    console.log("✓ scenario 2 passed");

    // Wait for the post-default score recompute. Score went 500→575 right
    // after fund (limit bump); after default it should drop below 500.
    const scoreChangedSse = await waitFor(
      () =>
        sseEvents.find(
          (e) =>
            e.kind === "score.changed" &&
            e.borrowerId === "borrower-bad" &&
            e.to < 500,
        ),
      8000,
    );
    console.log(
      "score.changed (post-default): borrower-bad",
      scoreChangedSse.from,
      "→",
      scoreChangedSse.to,
    );
    assert(
      scoreChangedSse.to < scoreChangedSse.from,
      `expected score drop after default, got ${scoreChangedSse.from}→${scoreChangedSse.to}`,
    );

    // ── SCENARIO 3: score recompute reflects events ─────────────────
    step("SCENARIO 3: score recompute reacts to inserted score_events");
    const seedReg = await http("POST", "/credit/register", {
      borrowerId: "borrower-seed",
      walletAddress: "0x" + "cc".repeat(20),
      serviceUrl: "http://localhost:4001",
      registrationApiKey: "claw_dev_test_seed",
    });
    assert(seedReg.status === 200, `seed register ${seedReg.status}`);

    const beforeSse = sseEvents.length;
    await ScoreEventModel.insertMany([
      {
        borrowerId: "borrower-seed",
        type: "loan_repaid",
        delta: 5,
        reason: "test",
        source: "manual",
        payload: { amount: 0.005 },
      },
      {
        borrowerId: "borrower-seed",
        type: "loan_repaid",
        delta: 5,
        reason: "test",
        source: "manual",
        payload: { amount: 0.005 },
      },
      {
        borrowerId: "borrower-seed",
        type: "loan_defaulted",
        delta: -80,
        reason: "test",
        source: "manual",
        payload: { amount: 0.005 },
      },
    ]);
    await BorrowerModel.updateOne(
      { borrowerId: "borrower-seed" },
      { $set: { defaultCount: 1 } },
    );

    const seedScoreEvent = await waitFor(
      () =>
        sseEvents
          .slice(beforeSse)
          .find(
            (e) =>
              e.kind === "score.changed" && e.borrowerId === "borrower-seed",
          ),
      6000,
    );
    console.log(
      "score.changed: borrower-seed",
      seedScoreEvent.from,
      "→",
      seedScoreEvent.to,
    );
    const seedBorrower = await BorrowerModel.findOne({
      borrowerId: "borrower-seed",
    });
    assert(seedBorrower!.score !== 500, "borrower-seed score moved off cold-start");
    assert(
      seedBorrower!.score < 500,
      `expected sub-500 score (default outweighs repays); got ${seedBorrower!.score}`,
    );
    console.log("✓ scenario 3 passed");

    // ── SCENARIO 4: default-loop catches stale FUNDED loan ──────────
    step("SCENARIO 4: default-loop catches stale FUNDED loan");
    const staleKey = "claw_dev_test_stale";
    setMockBalanceForKey(staleKey, "10.00"); // doesn't matter — queue will be removed
    const stale = await fundLoan({
      borrowerId: "borrower-stale",
      apiKey: staleKey,
      wallet: "0x" + "dd".repeat(20),
    });
    console.log("loanId:", stale.loanId);

    // Remove the queue item so collection-loop won't act on it.
    await RepaymentQueueModel.deleteOne({ loanId: stale.loanId });
    // Backdate dueAt to past + grace.
    await LoanModel.updateOne(
      { loanId: stale.loanId },
      { $set: { dueAt: new Date(Date.now() - 10_000) } },
    );

    const staleDefaulted = await waitFor(async () => {
      const l = await LoanModel.findOne({ loanId: stale.loanId });
      return l?.status === "DEFAULTED" ? l : null;
    }, 8000);
    console.log("→ stale loan DEFAULTED:", staleDefaulted.loanId);

    const staleSse = await waitFor(
      () =>
        sseEvents.find(
          (e) =>
            e.kind === "loan.defaulted" &&
            e.loanId === stale.loanId &&
            e.reason === "due_date_passed",
        ),
      3000,
    );
    assert(staleSse, "SSE loan.defaulted reason=due_date_passed");
    console.log("✓ scenario 4 passed");

    console.log("");
    console.log("✓ all four scenarios passed");
  } finally {
    step("teardown");
    unsub();
    collection.stop();
    score.stop();
    defaults.stop();
    await app.close();
    await disconnect();
    console.log("loops stopped, server closed, db disconnected");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
