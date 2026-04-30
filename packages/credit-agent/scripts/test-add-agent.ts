// Phase X4 acceptance test — add-agent + monthly rent flow.
//
// Boots credit-agent in one process, then drives 3 scenarios:
//
//   1. Built-ins seeded on boot (3 agents present in DB after buildServer).
//   2. Operator registers a new agent → escrow paid → agent activates,
//      subscription transitions PENDING_PAYMENT → ACTIVE, registry now
//      lists 4 agents.
//   3. Operator registers another agent → don't pay → mock session
//      expired → subscription → EXPIRED, agent stays inactive (registry
//      still 4).

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../.env") });

process.env.LOCUS_OFFLINE_MODE = "1";
process.env.PORT = "4299";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4299";
process.env.LOOPS_DISABLED = "0";
process.env.SUBSCRIPTION_WATCHER_INTERVAL_SECONDS = "1";
process.env.COLLECTION_LOOP_INTERVAL_SECONDS = "5";
process.env.SCORE_LOOP_INTERVAL_SECONDS = "5";
process.env.DEFAULT_LOOP_INTERVAL_SECONDS = "5";

const ORIG_URI = process.env.MONGODB_URI ?? "";
process.env.MONGODB_URI = ORIG_URI.replace(/\/credit(\?|$)/, "/credit_test$1");

const {
  AgentModel,
  AgentSubscriptionModel,
  CounterModel,
  MockLocusClient,
  markMockSessionExpired,
  setMockBalanceForKey,
  _resetMockState,
  connect,
  disconnect,
} = await import("@credit/shared");

const { loadConfig } = await import("../src/lib/config.js");
const { initLocusClient } = await import("../src/lib/locus.js");
const { buildServer: buildCreditServer } = await import("../src/server.js");
const { startSubscriptionWatcher } = await import(
  "../src/jobs/subscription-watcher.js"
);
const { _resetBus, subscribe } = await import("../src/lib/sse-bus.js");

const PORT = 4299;
const BASE = `http://127.0.0.1:${PORT}`;
const PAYER_KEY = "claw_test_addagent_payer";

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
  console.log("test-add-agent — Phase X4 acceptance test");
  console.log("MONGODB_URI:", process.env.MONGODB_URI?.replace(/:[^:@]+@/, ":***@"));

  step("connect Mongo, clear collections, reset in-memory state");
  const cfg = loadConfig();
  await connect(cfg.mongoUri);
  await Promise.all([
    AgentModel.deleteMany({}),
    AgentSubscriptionModel.deleteMany({}),
    CounterModel.deleteMany({}),
  ]);
  _resetMockState();
  _resetBus();

  step("subscribe to SSE bus");
  const sseEvents: any[] = [];
  const unsub = subscribe((e: any) => sseEvents.push(e));

  step("boot credit-agent + subscription-watcher");
  initLocusClient(cfg);
  const credit = await buildCreditServer(cfg);
  await credit.listen({ port: PORT, host: "127.0.0.1" });
  const subscription = startSubscriptionWatcher({
    logger: credit.log,
    config: cfg,
  });

  setMockBalanceForKey(PAYER_KEY, "1.0000");
  const payer = new MockLocusClient({ apiKey: PAYER_KEY });

  try {
    // ════════════════════════════════════════════════════════════════════
    step("TEST 1 — built-ins seeded on boot");
    // ════════════════════════════════════════════════════════════════════
    const builtInDocs = await AgentModel.find({ isBuiltIn: true }).lean();
    const builtInIds = builtInDocs.map((d) => d.agentId).sort();
    console.log("built-in agents:", builtInIds);
    // V1 expanded the marketplace to 6 built-ins (3 real backends + 3
    // virtual personas routed via shared services).
    const EXPECTED = [
      "code-reviewer",
      "code-writer",
      "image-creator",
      "qa-tester",
      "summarizer",
      "translator",
    ].sort();
    assert(
      builtInIds.length === EXPECTED.length,
      `expected ${EXPECTED.length} built-ins, got ${builtInIds.length}`,
    );
    assert(
      JSON.stringify(builtInIds) === JSON.stringify(EXPECTED),
      "built-in agentIds match expected list",
    );
    for (const d of builtInDocs) {
      assert(d.isActive === true, `built-in ${d.agentId} should be active`);
      assert(d.isBuiltIn === true, `built-in ${d.agentId} should be marked built-in`);
    }

    const reg1 = await http("GET", "/agents/registry");
    assert(reg1.status === 200, "registry status 200");
    assert(
      reg1.json.agents.length === EXPECTED.length,
      `registry should list ${EXPECTED.length}, got ${reg1.json.agents.length}`,
    );
    console.log("✓ TEST 1 PASSED");

    // ════════════════════════════════════════════════════════════════════
    step("TEST 2 — register agent → pay rent → activate");
    // ════════════════════════════════════════════════════════════════════
    // Use a non-built-in agentId — V1 expanded built-ins to include
    // image-creator, so we register a new persona instead.
    const NEW_AGENT_ID = "demo-painter";
    const reg2body = {
      agentId: NEW_AGENT_ID,
      displayName: "Demo Painter",
      description: "Demo-only agent registered during X4 acceptance test.",
      category: "Creative" as const,
      emoji: "🎨",
      pricingUsdc: 0.012,
      operatorName: "Charlie",
      operatorEmail: "charlie@example.com",
      serviceUrl: "http://localhost:4099",
      walletAddress: "0x" + "11".repeat(20),
      capabilities: ["Generates 512×512 images", "Multiple style presets"],
    };
    const reg2res = await http("POST", "/agents/register", reg2body);
    console.log("register:", reg2res.status, reg2res.json?.subscription?.subscriptionId);
    assert(reg2res.status === 200, `register status ${reg2res.status}`);
    const subId = reg2res.json.subscription.subscriptionId as string;
    const sessionId = reg2res.json.sessionId as string;
    const operatorId = reg2res.json.subscription.operatorId as string;

    assert(typeof subId === "string" && subId.startsWith("S_"), "subscription id minted");
    assert(operatorId.startsWith("op-"), "operator id derived from email");

    // Agent should be in DB but inactive.
    const inactive = await AgentModel.findOne({ agentId: NEW_AGENT_ID });
    assert(inactive, "agent persisted");
    assert(inactive.isActive === false, "agent starts inactive");

    // Registry should still only show built-ins (the new agent is inactive).
    const reg2list = await http("GET", "/agents/registry");
    assert(
      reg2list.json.agents.length === EXPECTED.length,
      "registry hides inactive agent until rent paid",
    );

    // Pay the rent session.
    await payer.agentPay(sessionId);

    // Wait for BOTH the subscription ACTIVE and the agent.isActive update.
    const both = await waitFor(async () => {
      const s = await AgentSubscriptionModel.findOne({ subscriptionId: subId }).lean();
      const a = await AgentModel.findOne({ agentId: NEW_AGENT_ID }).lean();
      return s?.status === "ACTIVE" && a?.isActive === true
        ? { sub: s, agent: a }
        : null;
    }, 15_000);
    const active = both.sub;
    const activated = both.agent;
    console.log("subscription ACTIVE:", { txHash: active.escrowTxHash, end: active.coverageEndAt });
    assert(active.escrowTxHash != null, "rent tx hash captured");
    assert(active.coverageStartAt != null, "coverage start set");
    assert(active.coverageEndAt != null, "coverage end set");
    assert(activated?.isActive === true, "agent now active");
    assert(activated?.activatedAt != null, "activatedAt set");

    // SSE assertions.
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "agent.registered" && e.subscriptionId === subId,
      "SSE agent.registered",
    );
    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "agent.activated" && e.subscriptionId === subId,
      "SSE agent.activated",
    );

    // Registry now shows built-ins + the new agent.
    const reg2listB = await http("GET", "/agents/registry");
    assert(
      reg2listB.json.agents.length === EXPECTED.length + 1,
      `registry should list ${EXPECTED.length + 1}, got ${reg2listB.json.agents.length}`,
    );
    const ids = reg2listB.json.agents.map((a: any) => a.agentId).sort();
    assert(ids.includes(NEW_AGENT_ID), `${NEW_AGENT_ID} in registry`);
    console.log("✓ TEST 2 PASSED");

    // ════════════════════════════════════════════════════════════════════
    step("TEST 3 — register agent → never pay → subscription expires");
    // ════════════════════════════════════════════════════════════════════
    const reg3body = {
      ...reg2body,
      agentId: "lazy-agent",
      displayName: "Lazy Agent",
      operatorEmail: "lazy@example.com",
    };
    const reg3res = await http("POST", "/agents/register", reg3body);
    assert(reg3res.status === 200, `register3 status ${reg3res.status}`);
    const subId3 = reg3res.json.subscription.subscriptionId as string;
    const sessionId3 = reg3res.json.sessionId as string;
    console.log("register3:", subId3);

    // Mark the rent session expired.
    const expired = markMockSessionExpired(sessionId3);
    assert(expired, "rent session marked expired");

    // Wait for subscription EXPIRED.
    const expiredSub = await waitFor(async () => {
      const s = await AgentSubscriptionModel.findOne({ subscriptionId: subId3 }).lean();
      return s?.status === "EXPIRED" ? s : null;
    }, 10_000);
    console.log("subscription EXPIRED:", expiredSub.escrowSessionStatus);
    assert(expiredSub.escrowSessionStatus === "EXPIRED", "session marked expired");

    // Agent stays inactive.
    const stillInactive = await AgentModel.findOne({ agentId: "lazy-agent" });
    assert(stillInactive?.isActive === false, "lazy-agent stays inactive");

    // Registry still has built-ins + the previously-paid demo-painter
    // (lazy-agent never paid rent, so it stays inactive).
    const reg3list = await http("GET", "/agents/registry");
    assert(
      reg3list.json.agents.length === EXPECTED.length + 1,
      `registry should still list ${EXPECTED.length + 1}, got ${reg3list.json.agents.length}`,
    );

    await assertSseSoon(
      sseEvents,
      (e) => e.kind === "subscription.expired" && e.subscriptionId === subId3,
      "SSE subscription.expired",
    );
    console.log("✓ TEST 3 PASSED");

    console.log("");
    console.log("════════════════════════════════════════");
    console.log("✓ ALL 3 ADD-AGENT TESTS PASSED");
    console.log("════════════════════════════════════════");
  } finally {
    step("teardown");
    unsub();
    subscription.stop();
    await credit.close();
    await disconnect();
    console.log("server closed, db disconnected");
  }
}

main().catch((err) => {
  console.error("");
  console.error("TEST FAILED:", err);
  process.exit(1);
});
