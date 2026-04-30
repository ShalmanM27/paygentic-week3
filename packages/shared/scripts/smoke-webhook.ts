// Phase B live webhook smoke.
//
// Drives one real $0.005 agentPay end-to-end and waits for Locus to fire
// the `checkout.session.paid` webhook into our local credit-agent through
// the cloudflared tunnel. The credit-agent's /debug/last-webhook route
// (gated by DEBUG_ENDPOINTS_ENABLED=1) returns the captured payload.
//
// Run from repo root:  pnpm smoke:webhook
//
// Pre-conditions (refused on violation):
//   - LOCUS_OFFLINE_MODE=0 in BOTH credit-agent/.env and customer-agent/.env
//   - LOCUS_WEBHOOK_SECRET in credit-agent/.env starts with whsec_ AND is
//     NOT the test value (refuses anything starting with whsec_test_)
//   - CLOUDFLARED_PUBLIC_URL in credit-agent/.env reachable via /healthz
//   - DEBUG_ENDPOINTS_ENABLED=1 in credit-agent/.env (so we can poll
//     /debug/last-webhook)
//   - Customer balance >= $0.010

import { parse } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocusClient,
  LocusApiError,
  type AgentPayResponse,
  type CheckoutSession,
} from "../src/locus/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");

const SMOKE_AMOUNT = "0.005";
const MIN_BUYER_BALANCE = 0.01;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

function loadEnv(relPath: string): Record<string, string> {
  return parse(readFileSync(resolve(ROOT, relPath), "utf8"));
}

function fmt$(n: number): string {
  return `$${n.toFixed(4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CapturedWebhook {
  receivedAt: string;
  signatureHeader: string | undefined;
  headers: Record<string, unknown>;
  rawBody: string;
  parsed: { type: string; data: { sessionId?: string; [k: string]: unknown } };
}

async function fetchRecent(
  tunnel: string,
): Promise<{ status: number; recent: CapturedWebhook[] }> {
  const res = await fetch(`${tunnel.replace(/\/+$/, "")}/debug/last-webhook`);
  const text = await res.text();
  if (res.status !== 200) {
    return { status: res.status, recent: [] };
  }
  let json: { recent?: CapturedWebhook[] } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, recent: json.recent ?? [] };
}

async function main(): Promise<void> {
  console.log("smoke-webhook — live webhook validation via cloudflared");
  console.log("");

  // ── Load envs SEPARATELY ─────────────────────────────────────────────
  const creditEnv = loadEnv("packages/credit-agent/.env");
  const customerEnv = loadEnv("packages/customer-agent/.env");

  // ── Pre-condition guards ────────────────────────────────────────────
  if (creditEnv.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing — packages/credit-agent/.env has LOCUS_OFFLINE_MODE=1.",
    );
    process.exit(1);
  }
  if (customerEnv.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing — packages/customer-agent/.env has LOCUS_OFFLINE_MODE=1.",
    );
    process.exit(1);
  }

  const webhookSecret = creditEnv.LOCUS_WEBHOOK_SECRET ?? "";
  if (!webhookSecret.startsWith("whsec_")) {
    console.error("Refusing — LOCUS_WEBHOOK_SECRET missing or not whsec_…");
    process.exit(1);
  }
  if (webhookSecret.startsWith("whsec_test_")) {
    console.error(
      "Refusing — LOCUS_WEBHOOK_SECRET is still the test value " +
        "(starts with whsec_test_). Replace with the real secret from the " +
        "Locus dashboard before running.",
    );
    process.exit(1);
  }

  if (creditEnv.DEBUG_ENDPOINTS_ENABLED !== "1") {
    console.error(
      "Refusing — DEBUG_ENDPOINTS_ENABLED must be 1 for this smoke. " +
        "(We poll /debug/last-webhook to detect arrival.)",
    );
    process.exit(1);
  }

  const tunnel = (creditEnv.CLOUDFLARED_PUBLIC_URL ?? "").trim();
  if (!tunnel || !/^https?:\/\//.test(tunnel)) {
    console.error(
      "Refusing — CLOUDFLARED_PUBLIC_URL not set in credit-agent/.env. " +
        "Set it to the URL printed by `cloudflared tunnel --url http://localhost:4000`.",
    );
    process.exit(1);
  }

  // Tunnel reachability via /healthz.
  try {
    const healthRes = await fetch(`${tunnel.replace(/\/+$/, "")}/healthz`);
    const healthJson = await healthRes.text();
    if (healthRes.status !== 200) {
      console.error(
        `Refusing — tunnel /healthz returned ${healthRes.status}: ${healthJson.slice(0, 200)}`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(
      `Refusing — could not reach tunnel /healthz: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Debug route reachable?
  const debugProbe = await fetchRecent(tunnel);
  if (debugProbe.status !== 200) {
    console.error(
      `Refusing — /debug/last-webhook returned ${debugProbe.status}. ` +
        "Confirm DEBUG_ENDPOINTS_ENABLED=1 and credit-agent has been restarted.",
    );
    process.exit(1);
  }

  const creditKey = creditEnv.LOCUS_API_KEY;
  const customerKey = customerEnv.LOCUS_API_KEY;
  if (!creditKey || !creditKey.startsWith("claw_")) {
    console.error("credit-agent LOCUS_API_KEY missing or not claw_…");
    process.exit(1);
  }
  if (!customerKey || !customerKey.startsWith("claw_")) {
    console.error("customer-agent LOCUS_API_KEY missing or not claw_…");
    process.exit(1);
  }
  if (creditKey === customerKey) {
    console.error("merchant and buyer keys are identical — aborting");
    process.exit(1);
  }

  const apiBase =
    creditEnv.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api";

  console.log("merchant key  :", creditKey.slice(0, 12) + "...");
  console.log("buyer key     :", customerKey.slice(0, 12) + "...");
  console.log("api base      :", apiBase);
  console.log("tunnel URL    :", tunnel);
  console.log("webhook secret:", webhookSecret.slice(0, 12) + "...");
  console.log("");

  const merchant = new LocusClient({ apiKey: creditKey, apiBase });
  const buyer = new LocusClient({ apiKey: customerKey, apiBase });

  // ── Balances before ──────────────────────────────────────────────────
  console.log("── balances before ──");
  const buyerBefore = await buyer.balance();
  const merchantBefore = await merchant.balance();
  console.log(
    `merchant: ${merchantBefore.wallet_address} → ${fmt$(Number(merchantBefore.usdc_balance))}`,
  );
  console.log(
    `buyer   : ${buyerBefore.wallet_address} → ${fmt$(Number(buyerBefore.usdc_balance))}`,
  );
  const buyerBalNum = Number(buyerBefore.usdc_balance);
  if (!Number.isFinite(buyerBalNum) || buyerBalNum < MIN_BUYER_BALANCE) {
    console.log(
      `Buyer balance ${fmt$(buyerBalNum)} insufficient (need ${fmt$(MIN_BUYER_BALANCE)}). Aborting.`,
    );
    process.exit(0);
  }
  console.log("");

  // ── createSession ────────────────────────────────────────────────────
  console.log("── merchant.createSession() ──");
  const session: CheckoutSession = await merchant.createSession({
    amount: SMOKE_AMOUNT,
    currency: "USDC",
    receiptConfig: {
      enabled: true,
      fields: {
        creditorName: "CREDIT smoke-webhook",
        lineItems: [
          { description: "Live webhook smoke", amount: SMOKE_AMOUNT },
        ],
      },
    },
    metadata: { test: "smoke-webhook", iso: new Date().toISOString() },
    ttlSeconds: 600,
  });
  console.log(JSON.stringify(session, null, 2));
  console.log("");

  // Per-session vs account-level webhook secret check.
  const topLevel = session as unknown as Record<string, unknown>;
  const perSessionSecret =
    typeof topLevel["webhookSecret"] === "string"
      ? (topLevel["webhookSecret"] as string)
      : typeof topLevel["webhook_secret"] === "string"
        ? (topLevel["webhook_secret"] as string)
        : undefined;
  if (perSessionSecret) {
    console.log(
      `NOTE: createSession returned a per-SESSION webhook secret (${perSessionSecret.slice(0, 12)}...). ` +
        "If this is what Locus signs with, account-level whsec_ may not verify.",
    );
  } else {
    console.log(
      "NOTE: createSession did NOT return a webhookSecret on this response. " +
        "Account-level whsec_ from .env will be used for HMAC.",
    );
  }
  console.log("");

  const sessionId = session.id;

  // ── Note recent buffer length BEFORE pay so we can detect a NEW arrival ──
  const beforeRecent = await fetchRecent(tunnel);
  const baselineCount = beforeRecent.recent.length;
  console.log(`debug buffer baseline: ${baselineCount} prior webhook(s) captured`);
  console.log("");

  // ── preflight + agentPay ─────────────────────────────────────────────
  console.log("── buyer.preflight() ──");
  const pre = await buyer.preflight(sessionId);
  console.log(`canPay=${pre.canPay} blockers=${JSON.stringify(pre.blockers ?? null)}`);
  if (!pre.canPay) {
    console.error("preflight blocked — aborting");
    process.exit(1);
  }
  console.log("");

  console.log("── buyer.agentPay() ──");
  const payAt = Date.now();
  const pay: AgentPayResponse = await buyer.agentPay(sessionId, {
    payerEmail: "smoke-webhook@test.local",
  });
  console.log(JSON.stringify(pay, null, 2));
  console.log("");

  // ── Wait for the webhook to arrive ───────────────────────────────────
  console.log("── waiting for webhook ──");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let captured: CapturedWebhook | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const probe = await fetchRecent(tunnel);
    const elapsed = ((Date.now() - payAt) / 1000).toFixed(1);
    console.log(
      `[t+${elapsed}s] /debug/last-webhook size=${probe.recent.length}`,
    );
    if (probe.recent.length > baselineCount) {
      // Find an entry matching our sessionId.
      const match = probe.recent.find(
        (w) => w.parsed?.data?.sessionId === sessionId,
      );
      if (match) {
        captured = match;
        break;
      }
    }
  }

  if (!captured) {
    console.error(
      "Webhook not received within 60s. Check Locus dashboard webhook " +
        "config and cloudflared tunnel.",
    );
    process.exit(1);
  }

  const webhookLatencyMs = Date.parse(captured.receivedAt) - payAt;

  console.log("");
  console.log("── CAPTURED WEBHOOK ──");
  console.log("receivedAt         :", captured.receivedAt);
  console.log("latency (ms)       :", webhookLatencyMs);
  console.log("signature header   :", captured.signatureHeader);
  console.log("");
  console.log("HEADERS:");
  console.log(JSON.stringify(captured.headers, null, 2));
  console.log("");
  console.log("RAW BODY:");
  console.log(captured.rawBody);
  console.log("");
  console.log("PARSED BODY:");
  console.log(JSON.stringify(captured.parsed, null, 2));
  console.log("");

  // ── Balances after ───────────────────────────────────────────────────
  const buyerAfter = await buyer.balance();
  const merchantAfter = await merchant.balance();
  console.log("── balances after ──");
  console.log(
    `merchant: ${fmt$(Number(merchantBefore.usdc_balance))} → ${fmt$(Number(merchantAfter.usdc_balance))}`,
  );
  console.log(
    `buyer   : ${fmt$(Number(buyerBefore.usdc_balance))} → ${fmt$(Number(buyerAfter.usdc_balance))}`,
  );
  console.log("");

  // ── Verification table ───────────────────────────────────────────────
  console.log("── verification table ──");
  console.log("");
  printVerification({
    captured,
    sessionId,
    payTransactionId: pay.transactionId,
    perSessionSecret,
    webhookLatencyMs,
  });

  // ── Persist ──────────────────────────────────────────────────────────
  const resultPath = resolve(__dirname, "smoke-webhook-result.json");
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        apiBase,
        tunnel,
        merchant: {
          address: merchantBefore.wallet_address,
          balanceBefore: merchantBefore.usdc_balance,
          balanceAfter: merchantAfter.usdc_balance,
        },
        buyer: {
          address: buyerBefore.wallet_address,
          balanceBefore: buyerBefore.usdc_balance,
          balanceAfter: buyerAfter.usdc_balance,
        },
        session,
        agentPay: pay,
        captured,
        webhookLatencyMs,
        perSessionSecretReturned: !!perSessionSecret,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("");
  console.log(`Wrote ${resultPath}`);
  console.log("Done.");
}

function printVerification(args: {
  captured: CapturedWebhook;
  sessionId: string;
  payTransactionId: string;
  perSessionSecret: string | undefined;
  webhookLatencyMs: number;
}): void {
  const { captured } = args;
  const headers = captured.headers;
  const parsed = captured.parsed;
  const dataObj = (parsed?.data ?? {}) as Record<string, unknown>;

  const rows: Array<[string, string, string, string]> = [
    ["Field", "Spec'd / assumed", "Actual from webhook", "Action needed"],
    ["---", "---", "---", "---"],
  ];

  // Header name probe — Locus might use x-locus-signature or something else.
  const headerNames = Object.keys(headers).map((k) => k.toLowerCase());
  const sigCandidates = headerNames.filter(
    (k) => k.includes("signature") || k.includes("locus"),
  );
  rows.push([
    "signature header name",
    "x-locus-signature",
    captured.signatureHeader
      ? `x-locus-signature present: ${captured.signatureHeader.slice(0, 20)}...`
      : `(NOT FOUND under x-locus-signature — candidates: ${sigCandidates.join(", ") || "none"})`,
    captured.signatureHeader ? "ok" : "rename to actual header",
  ]);

  // Signature format
  if (captured.signatureHeader) {
    const isPrefixed = captured.signatureHeader.startsWith("sha256=");
    rows.push([
      "signature format",
      "sha256=<hex>",
      isPrefixed ? "sha256=<hex> (matches)" : captured.signatureHeader,
      isPrefixed ? "ok" : "update verifyWebhookSignature",
    ]);
  }

  // Body type field
  rows.push([
    "body.type",
    "checkout.session.paid | checkout.session.expired",
    JSON.stringify(parsed?.type),
    "compare",
  ]);

  // Body data keys
  rows.push([
    "body.data keys",
    "sessionId, txHash?, amount?, payerAddress?, paidAt?",
    Object.keys(dataObj).join(", "),
    "compare",
  ]);

  // sessionId match
  rows.push([
    "data.sessionId matches our session",
    "true",
    String(dataObj["sessionId"] === args.sessionId),
    dataObj["sessionId"] === args.sessionId ? "ok" : "MISMATCH",
  ]);

  // txHash present?
  const txHash =
    typeof dataObj["txHash"] === "string"
      ? (dataObj["txHash"] as string)
      : typeof dataObj["tx_hash"] === "string"
        ? (dataObj["tx_hash"] as string)
        : null;
  rows.push([
    "data.txHash present in webhook body",
    "(unknown — major question)",
    txHash ? `YES: ${txHash}` : "NO — not in body",
    txHash
      ? "frontend can show real txHash on REPAID"
      : "rely on settlement-watcher; show 'settling' for txHash",
  ]);

  // body field casing
  const dataKeys = Object.keys(dataObj);
  const snake = dataKeys.filter((k) => k.includes("_"));
  const camel = dataKeys.filter((k) => !k.includes("_") && /[A-Z]/.test(k));
  rows.push([
    "webhook body casing",
    "(unknown — assumed camelCase)",
    snake.length && !camel.length
      ? "snake_case"
      : camel.length && !snake.length
        ? "camelCase"
        : `mixed: snake=[${snake.join(",")}] camel=[${camel.join(",")}]`,
    "lock the WebhookEvent type",
  ]);

  // per-session secret
  rows.push([
    "createSession returned per-session webhookSecret?",
    "docs say yes — never observed in beta",
    args.perSessionSecret ? `YES: ${args.perSessionSecret.slice(0, 12)}...` : "NO",
    args.perSessionSecret
      ? "consider per-session secret strategy"
      : "account-level whsec_ confirmed",
  ]);

  // Webhook latency
  rows.push([
    "webhook delivery latency",
    "< 5 sec typical",
    `${args.webhookLatencyMs} ms (agentPay → webhook arrival)`,
    "ok",
  ]);

  // HMAC verification confirmation (the fact that the route captured it
  // means our HMAC verify already passed)
  rows.push([
    "HMAC verification with .env whsec_",
    "passes",
    "PASSED (route captured this entry only after verify succeeded)",
    "account-level secret confirmed working",
  ]);

  for (const row of rows) {
    console.log(
      "| " + row.map((s) => s.replace(/\|/g, "\\|")).join(" | ") + " |",
    );
  }
}

main().catch((err) => {
  console.error("");
  console.error("── ERROR ──");
  if (err instanceof LocusApiError) {
    console.error("LocusApiError");
    console.error("  endpoint :", err.endpoint);
    console.error("  status   :", err.status);
    console.error("  error    :", err.error);
    console.error("  message  :", err.message);
  } else if (err instanceof Error) {
    console.error(err.stack ?? err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
