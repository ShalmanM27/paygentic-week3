// Acceptance test for the Phase 8 backend routes that the frontend
// pages consume. Boots credit-agent on a test port, seeds Mongo with
// a borrower + two loans + score events + transactions, then hits each
// new route and asserts response shape.

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

process.env.LOCUS_OFFLINE_MODE = "1";
process.env.LOOPS_DISABLED = "1";
process.env.PORT = "4099";
process.env.DEBUG_ENDPOINTS_ENABLED = "1";
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
const { buildServer } = await import("../src/server.js");
const { _resetAgentsCache } = await import("../src/routes/agents.js");

const BASE = "http://localhost:4099";
const BORROWER_ID = "agent-a";
const TEST_KEY = "claw_dev_test_frontend_routes";
const TEST_WALLET = "0x" + "ab".repeat(20); // 42 chars

function step(label: string): void {
  console.log("");
  console.log(`── ${label} ──`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function http(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text.length ? JSON.parse(text) : null; } catch { json = { _nonjson: text }; }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  console.log("test-frontend-routes — Phase 8 route shape acceptance");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect + clear test DB");
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
  _resetAgentsCache();
  setMockBalanceForKey(TEST_KEY, "0.5000");

  step("seed: 1 borrower, 2 loans, 4 score events, 5 transactions");
  await BorrowerModel.create({
    borrowerId: BORROWER_ID,
    walletAddress: TEST_WALLET,
    apiKey: TEST_KEY,
    serviceUrl: "http://localhost:4001",
    status: "ACTIVE",
    score: 720,
    limit: 0.05,
    outstanding: 0.0051,
    defaultCount: 1,
    registeredAt: new Date(Date.now() - 3600 * 1000),
  });
  await LoanModel.create([
    {
      loanId: "L_0001",
      borrowerId: BORROWER_ID,
      amount: 0.005,
      interestRate: 0.18,
      repayAmount: 0.0051,
      purpose: "scrape",
      decisionToken: "dt_test_a",
      targetSessionId: "sess_target_1",
      disbursementStatus: "CONFIRMED",
      disbursementTxHash: "0xabcdef",
      repaymentSessionId: "sess_repay_1",
      repaymentTxHash: "0x123456",
      status: "REPAID",
      createdAt: new Date(Date.now() - 1800 * 1000),
      fundedAt: new Date(Date.now() - 1700 * 1000),
      dueAt: new Date(Date.now() + 3600 * 1000),
      closedAt: new Date(Date.now() - 1200 * 1000),
    },
    {
      loanId: "L_0002",
      borrowerId: BORROWER_ID,
      amount: 0.003,
      interestRate: 0.18,
      repayAmount: 0.0031,
      purpose: "scrape",
      decisionToken: "dt_test_b",
      targetSessionId: "sess_target_2",
      disbursementStatus: "CONFIRMED",
      disbursementTxHash: "0xdeadbeef",
      repaymentSessionId: "sess_repay_2",
      status: "FUNDED",
      createdAt: new Date(),
      fundedAt: new Date(),
      dueAt: new Date(Date.now() + 3600 * 1000),
    },
  ]);
  await ScoreEventModel.insertMany([
    { borrowerId: BORROWER_ID, type: "loan_repaid", delta: 5, reason: "L_0001", source: "loop", payload: { loanId: "L_0001", amount: 0.0051 } },
    { borrowerId: BORROWER_ID, type: "loan_defaulted", delta: -80, reason: "old default", source: "loop", payload: { loanId: "L_old", amount: 0.002 } },
    { borrowerId: BORROWER_ID, type: "score_recomputed", delta: 5, reason: "periodic", source: "loop" },
    { borrowerId: BORROWER_ID, type: "session_paid", delta: 3, reason: "rev", source: "webhook" },
  ]);
  await TransactionModel.insertMany([
    { type: "draw", borrowerId: BORROWER_ID, amount: 0.005, sessionId: "sess_target_1", txHash: "0xabcdef", status: "CONFIRMED", loanId: "L_0001" },
    { type: "repayment", borrowerId: BORROWER_ID, amount: 0.0051, sessionId: "sess_repay_1", txHash: "0x123456", status: "CONFIRMED", loanId: "L_0001" },
    { type: "draw", borrowerId: BORROWER_ID, amount: 0.003, sessionId: "sess_target_2", txHash: "0xdeadbeef", status: "PENDING", loanId: "L_0002" },
    { type: "score_sale", borrowerId: null, amount: 0.002, sessionId: "sess_scs_1", txHash: null, status: "CONFIRMED", loanId: null },
    { type: "score_sale", borrowerId: null, amount: 0.002, sessionId: "sess_scs_2", txHash: null, status: "CONFIRMED", loanId: null },
  ]);

  step("boot credit-agent");
  initLocusClient(cfg);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });

  try {
    // ── /transactions ──
    step("GET /transactions");
    const txAll = await http(`${BASE}/transactions`);
    assert(txAll.status === 200, `status ${txAll.status}`);
    assert(Array.isArray(txAll.json.transactions), "transactions is array");
    assert(txAll.json.transactions.length === 5, `expected 5 txs, got ${txAll.json.transactions.length}`);
    assert(txAll.json.pagination.total === 5, "pagination.total");
    assert(txAll.json.pagination.hasMore === false, "pagination.hasMore");
    console.log(`  ✓ ${txAll.json.transactions.length} transactions, total=${txAll.json.pagination.total}`);

    step("GET /transactions?type=repayment");
    const txRepay = await http(`${BASE}/transactions?type=repayment`);
    assert(txRepay.status === 200, "status");
    assert(txRepay.json.transactions.length === 1, "1 repayment");
    assert(txRepay.json.transactions[0].type === "repayment", "filtered type");
    console.log("  ✓ filter by type works");

    step("GET /transactions?limit=2&offset=0 then offset=2");
    const txPage1 = await http(`${BASE}/transactions?limit=2&offset=0`);
    const txPage2 = await http(`${BASE}/transactions?limit=2&offset=2`);
    assert(txPage1.json.transactions.length === 2, "page 1 size");
    assert(txPage2.json.transactions.length === 2, "page 2 size");
    assert(txPage1.json.pagination.hasMore === true, "page 1 hasMore");
    assert(txPage1.json.transactions[0]._id !== txPage2.json.transactions[0]._id, "no overlap");
    console.log("  ✓ pagination math correct");

    // ── /agents/:id ──
    step("GET /agents/agent-a");
    const ag = await http(`${BASE}/agents/${BORROWER_ID}`);
    assert(ag.status === 200, "status");
    assert(ag.json.borrower.borrowerId === BORROWER_ID, "borrowerId");
    assert(ag.json.borrower.score === 720, "score");
    assert(ag.json.borrower.limit === 0.05, "limit");
    assert(ag.json.borrower.apiKeyPrefix?.startsWith("claw_"), "apiKey masked");
    assert(ag.json.recentLoans.length === 2, "2 loans");
    assert(ag.json.totals.openLoanCount === 1, "1 open loan");
    assert(ag.json.totals.lifetimeRepaid === 0.0051, "lifetimeRepaid");
    assert(ag.json.totals.lifetimeDefaulted === 0.002, "lifetimeDefaulted");
    console.log("  ✓ borrower + loans + totals shape OK");

    step("GET /agents/nonexistent");
    const ag404 = await http(`${BASE}/agents/nonexistent`);
    assert(ag404.status === 404, "404");
    console.log("  ✓ 404 on missing borrower");

    // ── /agents/:id/balance ──
    step("GET /agents/agent-a/balance (uncached)");
    const bal1 = await http(`${BASE}/agents/${BORROWER_ID}/balance`);
    assert(bal1.status === 200, "status");
    assert(typeof bal1.json.usdcBalance === "number", "usdcBalance numeric");
    assert(bal1.json.usdcBalance === 0.5, `balance=${bal1.json.usdcBalance}`);
    assert(bal1.json.cached === false, "first call uncached");
    console.log(`  ✓ balance=$${bal1.json.usdcBalance} cached=false`);

    step("GET /agents/agent-a/balance (cached)");
    const bal2 = await http(`${BASE}/agents/${BORROWER_ID}/balance`);
    assert(bal2.json.cached === true, "second call cached");
    console.log("  ✓ second call cached=true");

    // ── /stats ──
    step("GET /stats");
    const st = await http(`${BASE}/stats`);
    assert(st.status === 200, "status");
    const fields = [
      "loansToday",
      "loansFundedTotal",
      "defaultRate24h",
      "defaultRateTotal",
      "volumeUsdcSettled",
      "activeBorrowers",
      "openLoans",
      "lastEventAt",
    ];
    for (const f of fields) assert(f in st.json, `field ${f}`);
    assert(typeof st.json.loansToday === "number", "loansToday number");
    assert(st.json.loansFundedTotal === 2, `loansFundedTotal=${st.json.loansFundedTotal}`);
    assert(st.json.openLoans === 1, "openLoans");
    assert(st.json.activeBorrowers === 1, "activeBorrowers");
    assert(st.json.volumeUsdcSettled === 0.005, `volume=${st.json.volumeUsdcSettled}`);
    console.log("  ✓ all 8 fields with correct types");

    // ── /score/:wallet/events ──
    step(`GET /score/${TEST_WALLET}/events`);
    const sev = await http(`${BASE}/score/${TEST_WALLET}/events`);
    assert(sev.status === 200, "status");
    assert(sev.json.borrowerId === BORROWER_ID, "borrowerId");
    assert(Array.isArray(sev.json.events), "events array");
    assert(sev.json.events.length === 4, `4 events, got ${sev.json.events.length}`);
    console.log(`  ✓ ${sev.json.events.length} events, types: ${sev.json.events.map((e: any) => e.type).join(", ")}`);

    // ── /loans/:loanId/sessions ──
    step("GET /loans/L_0001/sessions");
    const ls = await http(`${BASE}/loans/L_0001/sessions`);
    assert(ls.status === 200, "status");
    assert(ls.json.loanId === "L_0001", "loanId");
    assert(ls.json.disbursement?.sessionId === "sess_target_1", "disbursement session");
    assert(ls.json.disbursement?.status === "CONFIRMED", "disbursement status");
    assert(ls.json.repayment?.sessionId === "sess_repay_1", "repayment session");
    assert(ls.json.repayment?.status === "PAID", "repayment PAID for REPAID loan");
    assert(ls.json.customer === null, "customer null (todo prod)");
    console.log("  ✓ disbursement + repayment slots populated, customer null");

    step("GET /loans/L_0002/sessions (FUNDED, not REPAID)");
    const ls2 = await http(`${BASE}/loans/L_0002/sessions`);
    assert(ls2.json.repayment?.status === "PENDING", "FUNDED loan repayment PENDING");
    console.log("  ✓ FUNDED loan repayment status PENDING");

    step("GET /loans/missing/sessions");
    const ls404 = await http(`${BASE}/loans/missing/sessions`);
    assert(ls404.status === 404, "404 on missing loan");
    console.log("  ✓ 404 on missing loan");

    console.log("");
    console.log("✓ all assertions passed");
  } finally {
    step("teardown");
    await app.close();
    await disconnect();
    console.log("done");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
