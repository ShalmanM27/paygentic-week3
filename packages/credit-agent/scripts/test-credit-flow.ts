// End-to-end test of the lend pathway against the mock Locus client.
// Boots the credit-agent server in-process on port 4099, registers a
// borrower, bumps their limit, draws, mints a target session via the mock,
// funds, asserts Mongo state, tears down. Acceptance test for Phase 2.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

// Force offline mode + a test DB regardless of .env values.
process.env.LOCUS_OFFLINE_MODE = "1";
process.env.LOOPS_DISABLED = "1";
process.env.PORT = "4099";
const ORIG_URI = process.env.MONGODB_URI ?? "";
process.env.MONGODB_URI = ORIG_URI.replace(/\/credit(\?|$)/, "/credit_test$1");

const {
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  TransactionModel,
  MockLocusClient,
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
const { initLocusClient } = await import("../src/lib/locus.js");
const { buildServer } = await import("../src/server.js");

const BASE = "http://localhost:4099";
const BORROWER_ID = "test-a";
const TEST_WALLET = "0x" + "11".repeat(20);

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

async function main(): Promise<void> {
  console.log("test-credit-flow — mock-mode acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect to test DB");
  const cfg = loadConfig();
  await connect(cfg.mongoUri);

  step("clear test collections + reset mock state");
  await Promise.all([
    BorrowerModel.deleteMany({}),
    LoanModel.deleteMany({}),
    RepaymentQueueModel.deleteMany({}),
    TransactionModel.deleteMany({}),
  ]);
  _resetMockState();

  step("init Locus mock + boot server");
  initLocusClient(cfg);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });

  try {
    step("POST /credit/register");
    const reg = await http("POST", "/credit/register", {
      borrowerId: BORROWER_ID,
      walletAddress: TEST_WALLET,
      serviceUrl: "http://localhost:4001",
      registrationApiKey: "claw_dev_test_borrower_apikey",
    });
    console.log("→", reg.status, reg.json);
    assert(reg.status === 200, `register status ${reg.status}`);
    assert(reg.json.ok === true, "register ok");
    assert(reg.json.score === 500, "register cold-start score");
    assert(reg.json.limit === 0, "register cold-start limit");

    step("manually bump borrower limit to 0.05");
    await BorrowerModel.updateOne({ borrowerId: BORROWER_ID }, { $set: { limit: 0.05 } });

    step("POST /credit/draw amount=0.005 ttl=3600");
    const draw = await http("POST", "/credit/draw", {
      borrowerId: BORROWER_ID,
      amount: 0.005,
      purpose: "wrapped-api/firecrawl-scrape",
      ttl: 3600,
    });
    console.log("→", draw.status, draw.json);
    assert(draw.status === 200, `draw status ${draw.status}`);
    assert(draw.json.approved === true, "draw approved");
    assert(typeof draw.json.decisionToken === "string", "decisionToken present");
    const decisionToken = draw.json.decisionToken as string;

    step("create mock target session as a third-party merchant");
    const merchant = new MockLocusClient({
      apiKey: "claw_dev_mock_merchant",
      mockBalance: "0",
    });
    const target = await merchant.createSession({
      amount: 0.005,
      currency: "USDC",
      receiptConfig: {
        enabled: true,
        fields: {
          creditorName: "TestMerchant",
          lineItems: [{ description: "scrape", amount: "0.005" }],
        },
      },
      metadata: { kind: "borrower-cost" },
      ttlSeconds: 600,
    });
    console.log("target session:", target.id);

    step("POST /credit/fund");
    const fund = await http("POST", "/credit/fund", {
      decisionToken,
      targetSessionId: target.id,
    });
    console.log("→", fund.status, fund.json);
    assert(fund.status === 200, `fund status ${fund.status}`);
    assert(typeof fund.json.loanId === "string", "loanId present");
    assert(
      typeof fund.json.repaymentSessionId === "string",
      "repaymentSessionId present",
    );
    assert(typeof fund.json.repayAmount === "number", "repayAmount is number");
    assert(typeof fund.json.dueAt === "string", "dueAt present");

    // dueAt should be ≈ now + 3600s (the requested ttl), NOT 86400s.
    const dueAtMs = Date.parse(fund.json.dueAt);
    const expectedDueMs = Date.now() + 3600 * 1000;
    const dueDriftSec = Math.abs(dueAtMs - expectedDueMs) / 1000;
    assert(dueDriftSec < 30, `dueAt drift ${dueDriftSec}s — expected ≈ now+3600s`);

    // repayAmount must match deterministic policy: principal + rate * ttl/yr.
    const SECONDS_PER_YEAR = 365 * 24 * 3600;
    const accrued = 0.005 * 0.18 * (3600 / SECONDS_PER_YEAR);
    const expectedRepay = Math.max(0.005 + 0.0001, 0.005 + accrued);
    assert(
      Math.abs(fund.json.repayAmount - expectedRepay) < 0.0001,
      `repayAmount ${fund.json.repayAmount} != expected ${expectedRepay}`,
    );
    const loanId = fund.json.loanId as string;

    step("Mongo assertions");
    const loan = await LoanModel.findOne({ loanId });
    assert(loan, "loan row exists");
    assert(loan.status === "FUNDED", `loan.status=${loan.status}`);
    console.log("loan:", {
      loanId: loan.loanId,
      status: loan.status,
      amount: loan.amount,
      repayAmount: loan.repayAmount,
      txHash: loan.disbursementTxHash,
    });

    const queue = await RepaymentQueueModel.findOne({ loanId });
    assert(queue, "repayment_queue row exists");
    assert(queue.state === "WAITING", `queue.state=${queue.state}`);
    console.log("queue:", {
      loanId: queue.loanId,
      state: queue.state,
      nextAttemptAt: queue.nextAttemptAt,
      amount: queue.amount,
    });

    const borrower = await BorrowerModel.findOne({ borrowerId: BORROWER_ID });
    assert(borrower, "borrower row exists");
    const expectedOutstanding = loan.repayAmount;
    assert(
      Math.abs(borrower.outstanding - expectedOutstanding) < 1e-9,
      `borrower.outstanding=${borrower.outstanding} expected≈${expectedOutstanding}`,
    );
    console.log("borrower.outstanding:", borrower.outstanding);

    const drawTx = await TransactionModel.findOne({ loanId, type: "draw" });
    assert(drawTx, "draw transaction row exists");
    console.log("draw tx:", {
      type: drawTx.type,
      amount: drawTx.amount,
      txHash: drawTx.txHash,
      status: drawTx.status,
    });

    console.log("");
    console.log("✓ all assertions passed");
  } finally {
    step("teardown");
    await app.close();
    await disconnect();
    console.log("server closed, db disconnected");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
