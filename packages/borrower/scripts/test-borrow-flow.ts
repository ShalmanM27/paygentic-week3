// Phase 5 acceptance test: borrower agent end-to-end (offline/mock).
//
//  - Boots credit-agent on :4099 (offline, loops disabled, test DB)
//  - Boots borrower-a on :4101 (offline, mocked low balance)
//  - Boots a tiny callback listener on :4102 (the "fake customer")
//  - Borrower-a registers with Credit; Credit's borrower limit bumped to 0.05
//  - Customer POSTs /work to borrower-a → 402 + sessionId
//  - Test synthesizes session.paid webhook (HMAC-signed) for that sessionId
//  - Borrower runs decide-borrow, draws+funds via Credit, runs doWork,
//    callbacks the fake customer
//
// Asserts: loan FUNDED in Mongo, callback received with mock content.

import { config as loadDotenv } from "dotenv";
import Fastify from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  postSignedWebhook,
  signWebhook,
} from "../../credit-agent/scripts/_test-helpers/sign-webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({
  path: resolve(__dirname, "../../credit-agent/.env"),
});

// Force test-friendly env BEFORE imports.
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
  setMockBalanceForKey,
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import(
  "../../credit-agent/src/lib/config.js"
);
const { initLocusClient } = await import(
  "../../credit-agent/src/lib/locus.js"
);
const { buildServer: buildCreditServer } = await import(
  "../../credit-agent/src/server.js"
);
const { _resetBus } = await import(
  "../../credit-agent/src/lib/sse-bus.js"
);

const {
  buildBorrowerServer,
  registerWithCredit,
  _resetJobStore,
} = await import("../src/index.js");
const { CreditClient } = await import("../src/lib/credit-client.js");

const CREDIT_PORT = 4099;
const BORROWER_PORT = 4101;
const CALLBACK_PORT = 4102;

const BORROWER_ID = "borrower-a";
const BORROWER_KEY = "claw_dev_test_borrow_flow_a";
const BORROWER_WEBHOOK_SECRET =
  "whsec_test_borrow_flow_a_b9ec85f2c3f4a8a6b07fd5d3";

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
  pollMs = 100,
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
  console.log("test-borrow-flow — Phase 5 acceptance test");
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
  _resetJobStore();

  step("init Locus mock + boot credit-agent");
  initLocusClient(cfg);
  const credit = await buildCreditServer(cfg);
  await credit.listen({ port: CREDIT_PORT, host: "127.0.0.1" });

  step("set borrower-a mock balance very low (force borrow)");
  setMockBalanceForKey(BORROWER_KEY, "0.0010");

  step("boot borrower-a");
  const borrowerConfig = {
    port: BORROWER_PORT,
    borrowerId: BORROWER_ID,
    locusApiKey: BORROWER_KEY,
    locusApiBase: cfg.locusApiBase,
    locusWebhookSecret: BORROWER_WEBHOOK_SECRET,
    locusOfflineMode: true,
    mockBalance: "0.0010",
    workPrice: 0.008,
    workCost: 0.005,
    safetyBuffer: 0.001,
    creditAgentUrl: `http://localhost:${CREDIT_PORT}`,
  };
  const borrower = await buildBorrowerServer(borrowerConfig);
  await borrower.app.listen({ port: BORROWER_PORT, host: "127.0.0.1" });

  step("register borrower-a with credit");
  const reg = await registerWithCredit(
    borrowerConfig,
    borrower.locus,
    borrower.credit,
  );
  console.log("register response:", reg);
  assert(reg.ok === true, "register ok");

  step("bump borrower-a limit to 0.05");
  await BorrowerModel.updateOne(
    { borrowerId: BORROWER_ID },
    { $set: { limit: 0.05 } },
  );

  step("boot fake customer callback listener on :4102");
  const callbackApp = Fastify({ logger: false });
  const received: Array<{ sessionId: string; result: any }> = [];
  callbackApp.post("/cb", async (req) => {
    received.push(req.body as any);
    return { ok: true };
  });
  await callbackApp.listen({ port: CALLBACK_PORT, host: "127.0.0.1" });

  try {
    step("POST /work to borrower-a");
    const work = await http(`http://localhost:${BORROWER_PORT}/work`, {
      method: "POST",
      body: {
        url: "https://example.com/article",
        callbackUrl: `http://localhost:${CALLBACK_PORT}/cb`,
      },
    });
    console.log("→", work.status, work.json);
    assert(work.status === 402, `work status ${work.status}`);
    assert(typeof work.json.sessionId === "string", "sessionId returned");
    const sessionId = work.json.sessionId as string;

    step("synthesize HMAC-signed webhook for that sessionId");
    const body = JSON.stringify({
      type: "checkout.session.paid",
      data: { sessionId, txHash: "0xfake_customer_paid" },
    });
    const sig = signWebhook(body, BORROWER_WEBHOOK_SECRET);
    const wh = await fetch(`http://localhost:${BORROWER_PORT}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-locus-signature": sig },
      body,
    });
    const whJson: any = await wh.json();
    console.log("→", wh.status, whJson);
    assert(wh.status === 200, `webhook status ${wh.status}`);

    step("assert: loan in Mongo (FUNDED)");
    const loan = await waitFor(async () => {
      const l = await LoanModel.findOne({ borrowerId: BORROWER_ID });
      return l && l.status === "FUNDED" ? l : null;
    }, 5000);
    console.log("loan:", {
      loanId: loan.loanId,
      status: loan.status,
      amount: loan.amount,
      repayAmount: loan.repayAmount,
      disbursementStatus: loan.disbursementStatus,
    });
    assert(loan.status === "FUNDED", `loan.status=${loan.status}`);

    step("assert: customer callback received doWork result");
    const cb = await waitFor(
      () => (received.length > 0 ? received[0] : null),
      5000,
    );
    console.log("callback received:", cb);
    assert(cb.sessionId === sessionId, "callback sessionId matches");
    assert(
      typeof cb.result?.content === "string" &&
        cb.result.content.includes("example.com"),
      `callback content unexpected: ${cb.result?.content}`,
    );

    step("assert: bad signature still rejected");
    const badRes = await fetch(`http://localhost:${BORROWER_PORT}/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-locus-signature": "sha256=" + "0".repeat(64),
      },
      body,
    });
    assert(badRes.status === 400, `bad-sig status ${badRes.status}`);

    console.log("");
    console.log("✓ all assertions passed");
  } finally {
    step("teardown");
    await borrower.app.close();
    await credit.close();
    await callbackApp.close();
    await disconnect();
    console.log("servers closed, db disconnected");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
