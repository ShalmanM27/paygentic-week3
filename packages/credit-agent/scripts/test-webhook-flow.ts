// End-to-end test for Phase 3: webhooks → score → SSE.
// Builds on the lend pathway, drives a session.paid webhook, asserts state
// changes, asserts the SSE bus delivers the matching loan.repaid event,
// then exercises /score and /score-report (both 402 and CLAIMABLE).

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  postSignedWebhook,
  signWebhook,
} from "./_test-helpers/sign-webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

process.env.LOCUS_OFFLINE_MODE = "1";
process.env.LOOPS_DISABLED = "1";
process.env.PORT = "4099";
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
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
const { initLocusClient } = await import("../src/lib/locus.js");
const { buildServer } = await import("../src/server.js");
const { _resetBus } = await import("../src/lib/sse-bus.js");

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
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
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

// ── SSE listener helper ────────────────────────────────────────────────
interface SseListener {
  events: any[];
  controller: AbortController;
  done: Promise<void>;
}

function startSseListener(): SseListener {
  const controller = new AbortController();
  const events: any[] = [];
  const done = (async () => {
    let res;
    try {
      res = await fetch(BASE + "/events", {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
    } catch {
      return;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, controller, done };
}

async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs: number,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Fund a loan helper (re-uses the mock merchant pattern) ─────────────
async function fundOneLoan(): Promise<{
  loanId: string;
  repaymentSessionId: string;
  borrowerOutstanding: number;
}> {
  const reg = await http("POST", "/credit/register", {
    borrowerId: BORROWER_ID,
    walletAddress: TEST_WALLET,
    serviceUrl: "http://localhost:4001",
    registrationApiKey: "claw_dev_test_borrower_apikey",
  });
  assert(reg.status === 200, `register status ${reg.status}`);

  await BorrowerModel.updateOne(
    { borrowerId: BORROWER_ID },
    { $set: { limit: 0.05 } },
  );

  const draw = await http("POST", "/credit/draw", {
    borrowerId: BORROWER_ID,
    amount: 0.005,
    purpose: "wrapped-api/firecrawl-scrape",
    ttl: 3600,
  });
  assert(draw.status === 200, `draw status ${draw.status}`);
  const decisionToken = draw.json.decisionToken as string;

  const merchant = new MockLocusClient({
    apiKey: "claw_dev_mock_merchant",
    mockBalance: "0",
  });
  const target = await merchant.createSession({
    amount: 0.005,
    currency: "USDC",
    ttlSeconds: 600,
  });

  const fund = await http("POST", "/credit/fund", {
    decisionToken,
    targetSessionId: target.id,
  });
  assert(fund.status === 200, `fund status ${fund.status}`);
  const borrower = await BorrowerModel.findOne({ borrowerId: BORROWER_ID });
  return {
    loanId: fund.json.loanId,
    repaymentSessionId: fund.json.repaymentSessionId,
    borrowerOutstanding: borrower!.outstanding,
  };
}

async function main(): Promise<void> {
  console.log("test-webhook-flow — Phase 3 acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect to test DB + clear");
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

  step("init Locus mock + boot server");
  initLocusClient(cfg);
  const app = await buildServer(cfg);
  await app.listen({ port: cfg.port, host: "127.0.0.1" });

  try {
    step("fund a loan");
    const { loanId, repaymentSessionId } = await fundOneLoan();
    console.log("loanId:", loanId, "repaymentSessionId:", repaymentSessionId);

    step("start SSE listener (after loan.funded already fired)");
    const sse = startSseListener();
    // Give the listener a beat to subscribe + receive the replay.
    await new Promise((r) => setTimeout(r, 200));
    const replayedFunded = sse.events.find(
      (e) => e.kind === "loan.funded" && e.loanId === loanId,
    );
    assert(replayedFunded, "SSE replay buffer included loan.funded");
    console.log("✓ SSE replayed loan.funded:", replayedFunded.loanId);

    step("synthesize repayment webhook with bad signature");
    const badBody = JSON.stringify({
      type: "checkout.session.paid",
      data: { sessionId: repaymentSessionId, txHash: "0xrepay_tx_test" },
    });
    const bad = await http("POST", "/webhooks/locus", undefined, {
      "x-locus-signature": "sha256=deadbeef",
    });
    void bad;
    const badRes = await fetch(BASE + "/webhooks/locus", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-locus-signature": "sha256=" + "0".repeat(64),
      },
      body: badBody,
    });
    assert(badRes.status === 400, `bad-sig status ${badRes.status} expected 400`);
    console.log("✓ bad signature rejected with 400");

    step("synthesize repayment webhook with valid signature");
    const body = JSON.stringify({
      type: "checkout.session.paid",
      data: { sessionId: repaymentSessionId, txHash: "0xrepay_tx_test" },
    });
    const sig = signWebhook(body, cfg.locusWebhookSecret);
    const wh = await fetch(BASE + "/webhooks/locus", {
      method: "POST",
      headers: { "content-type": "application/json", "x-locus-signature": sig },
      body,
    });
    const whJson: any = await wh.json();
    console.log("→", wh.status, whJson);
    assert(wh.status === 200, `webhook status ${wh.status}`);
    assert(whJson.ok === true, "webhook ok=true");

    step("Mongo assertions after repayment");
    const loan = await LoanModel.findOne({ loanId });
    assert(loan?.status === "REPAID", `loan.status=${loan?.status}`);
    assert(loan?.repaymentTxHash === "0xrepay_tx_test", "repaymentTxHash recorded");

    const borrower = await BorrowerModel.findOne({ borrowerId: BORROWER_ID });
    assert(
      Math.abs((borrower?.outstanding ?? 99) - 0) < 1e-9,
      `borrower.outstanding=${borrower?.outstanding} expected ≈ 0`,
    );

    const repaidEvent = await ScoreEventModel.findOne({
      borrowerId: BORROWER_ID,
      type: "loan_repaid",
    });
    assert(repaidEvent, "score_event loan_repaid created");

    const repayTx = await TransactionModel.findOne({
      loanId,
      type: "repayment",
    });
    assert(repayTx?.status === "CONFIRMED", "repayment transaction recorded");

    const queue = await RepaymentQueueModel.findOne({ loanId });
    assert(queue?.state === "COMPLETED", `queue.state=${queue?.state}`);
    console.log("✓ all DB state advanced correctly");

    step("SSE: loan.repaid arrived within 2s");
    const repaidSse = await waitFor(
      () =>
        sse.events.find((e) => e.kind === "loan.repaid" && e.loanId === loanId),
      2000,
    );
    console.log("✓ SSE loan.repaid:", repaidSse.loanId, "tx:", repaidSse.txHash);

    step("GET /score?wallet=...");
    const score = await http("GET", `/score?wallet=${TEST_WALLET}`);
    console.log("→", score.status, score.json);
    assert(score.status === 200, `score status ${score.status}`);
    assert(typeof score.json.score === "number", "score is number");
    assert(typeof score.json.tier === "string", "tier is string");
    assert(typeof score.json.openLoans === "number", "openLoans is number");

    step("POST /score-report → /result 402 → webhook → /result 200");
    const report = await http("POST", "/score-report", { wallet: TEST_WALLET });
    console.log("→", report.status, report.json);
    assert(report.status === 200, `report status ${report.status}`);
    const reportSessionId = report.json.sessionId as string;
    assert(typeof reportSessionId === "string", "report sessionId present");

    const result402 = await http(
      "GET",
      `/score-report/${reportSessionId}/result`,
    );
    console.log("→ result(402):", result402.status, result402.json);
    assert(result402.status === 402, `pre-pay status ${result402.status}`);

    const reportBody = JSON.stringify({
      type: "checkout.session.paid",
      data: { sessionId: reportSessionId, txHash: "0xreport_tx_test" },
    });
    const reportSig = signWebhook(reportBody, cfg.locusWebhookSecret);
    const reportWh = await fetch(BASE + "/webhooks/locus", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-locus-signature": reportSig,
      },
      body: reportBody,
    });
    assert(reportWh.status === 200, `report webhook status ${reportWh.status}`);

    // Allow event loop to process the DB write
    await new Promise((r) => setTimeout(r, 100));
    const result200 = await http(
      "GET",
      `/score-report/${reportSessionId}/result`,
    );
    console.log("→ result(200):", result200.status, "score=", result200.json.score, "tier=", result200.json.tier);
    assert(result200.status === 200, `post-pay status ${result200.status}`);
    assert(typeof result200.json.score === "number", "report score is number");
    assert(
      typeof result200.json.components.repaymentPunctuality === "number",
      "components present",
    );
    assert(Array.isArray(result200.json.events), "events array present");

    // Mutate borrower score AFTER first delivery; second read must return
    // the original snapshot, not the mutated value.
    const originalScore = result200.json.score as number;
    const mutated = originalScore + 137;
    await BorrowerModel.updateOne(
      { borrowerId: BORROWER_ID },
      { $set: { score: mutated } },
    );

    const result200b = await http(
      "GET",
      `/score-report/${reportSessionId}/result`,
    );
    assert(result200b.status === 200, "DELIVERED is idempotent on re-read");
    assert(
      result200b.json.score === originalScore,
      `snapshot expected ${originalScore} got ${result200b.json.score} — buyer-locked report leaked live score`,
    );
    console.log(
      `✓ snapshot held: borrower.score=${mutated} but report still served ${result200b.json.score}`,
    );

    const reportRow = await ScoreReportModel.findOne({ sessionId: reportSessionId });
    assert(reportRow?.status === "DELIVERED", "report row flipped to DELIVERED");
    assert(
      reportRow.snapshotScore === originalScore,
      `snapshot row score=${reportRow.snapshotScore}`,
    );

    step("SSE: score.sold arrived");
    const soldSse = await waitFor(
      () => sse.events.find((e) => e.kind === "score.sold"),
      2000,
    );
    console.log("✓ SSE score.sold:", soldSse.sessionId, soldSse.amount);

    sse.controller.abort();
    await sse.done.catch(() => {});

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
