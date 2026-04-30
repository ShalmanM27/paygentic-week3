// =============================================================================
// STATUS: ARCHIVED 2026-04-30.
// This script's polling step relies on /checkout/agent/payments/:id, which
// returns 403 in beta for both buyer and merchant on transactions we
// genuinely initiated and that BaseScan confirms settled. Kept for type-
// shape reference only. DO NOT RUN.
//
// Use webhook-driven confirmation instead. See Phase B (smoke-webhook.ts)
// for the live webhook validation workflow, and the "Architectural decision:
// webhook-driven confirmation" block in CLAUDE.md.
//
// Type discoveries captured before archival:
//   - createSession    camelCase, checkoutUrl present at create only
//   - getSession       camelCase, adds metadata + createdAt
//   - preflight        FLAT envelope, canPay, sellerWalletAddress
//   - agentPay         camelCase, lowercase status enum, statusEndpoint
//   - /pay/balance     snake_case
//   - /pay/send        snake_case, amount as number
// =============================================================================
//
// Phase A live smoke: drives a real agent-pay end-to-end.
//
//   merchant = credit-agent   (createSession; receives $0.005)
//   buyer    = customer-agent (preflight + agent-pay)
//
// Hard-coded $0.005 spend (single payment). Refuses if either service
// is in offline mode or if buyer balance < $0.010.

import { parse } from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocusClient,
  LocusApiError,
  type AgentPayResponse,
  type PaymentStatus,
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

async function main(): Promise<void> {
  console.log("smoke-pay — live agent-pay smoke (one payment, $0.005)");
  console.log("");

  // ── Load both envs SEPARATELY — never let process.env clobber them ──
  const creditEnv = loadEnv("packages/credit-agent/.env");
  const customerEnv = loadEnv("packages/customer-agent/.env");

  // ── Guards ──
  if (creditEnv.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing — packages/credit-agent/.env has LOCUS_OFFLINE_MODE=1. " +
        "Set to 0 to proceed.",
    );
    process.exit(1);
  }
  if (customerEnv.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing — packages/customer-agent/.env has LOCUS_OFFLINE_MODE=1. " +
        "Set to 0 to proceed.",
    );
    process.exit(1);
  }

  const creditKey = creditEnv.LOCUS_API_KEY;
  const customerKey = customerEnv.LOCUS_API_KEY;
  if (!creditKey || !creditKey.startsWith("claw_")) {
    console.error("credit-agent LOCUS_API_KEY missing or not claw_");
    process.exit(1);
  }
  if (!customerKey || !customerKey.startsWith("claw_")) {
    console.error("customer-agent LOCUS_API_KEY missing or not claw_");
    process.exit(1);
  }
  if (creditKey === customerKey) {
    console.error("merchant and buyer keys are identical — aborting");
    process.exit(1);
  }

  const apiBase =
    creditEnv.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api";

  console.log("merchant key:", creditKey.slice(0, 12) + "...");
  console.log("buyer key   :", customerKey.slice(0, 12) + "...");
  console.log("api base    :", apiBase);
  console.log("");

  const merchant = new LocusClient({ apiKey: creditKey, apiBase });
  const buyer = new LocusClient({ apiKey: customerKey, apiBase });

  // ── Pre-flight balances ──
  console.log("── balances before ──");
  const buyerBefore = await buyer.balance();
  const merchantBefore = await merchant.balance();
  console.log(
    `merchant: ${merchantBefore.wallet_address} → ${fmt$(Number(merchantBefore.usdc_balance))}`,
  );
  console.log(
    `buyer   : ${buyerBefore.wallet_address} → ${fmt$(Number(buyerBefore.usdc_balance))}`,
  );
  console.log("");

  const buyerBalNum = Number(buyerBefore.usdc_balance);
  if (!Number.isFinite(buyerBalNum) || buyerBalNum < MIN_BUYER_BALANCE) {
    console.log(
      `Buyer balance ${fmt$(buyerBalNum)} insufficient ` +
        `(need ${fmt$(MIN_BUYER_BALANCE)} minimum, payment ${SMOKE_AMOUNT}). Aborting.`,
    );
    process.exit(0);
  }

  // ── createSession (merchant) ──
  console.log("── merchant.createSession() ──");
  const session = await merchant.createSession({
    amount: SMOKE_AMOUNT,
    currency: "USDC",
    receiptConfig: {
      enabled: true,
      fields: {
        creditorName: "CREDIT smoke",
        lineItems: [
          { description: "Live agent-pay smoke", amount: SMOKE_AMOUNT },
        ],
      },
    },
    metadata: { test: "smoke-pay", iso: new Date().toISOString() },
    ttlSeconds: 600,
  });
  console.log(JSON.stringify(session, null, 2));
  console.log("");
  console.log("sessionId  :", session.id);
  console.log("checkoutUrl:", session.checkoutUrl ?? "(absent)");
  console.log("");

  // ── preflight (buyer) ──
  console.log("── buyer.preflight() ──");
  const pre = await buyer.preflight(session.id);
  console.log(JSON.stringify(pre, null, 2));
  console.log("");
  if (!pre.canPay) {
    console.error("preflight reports canPay:false — aborting");
    console.error("blockers:", pre.blockers ?? "(none)");
    process.exit(1);
  }

  // ── agentPay (buyer) — RAW LOG ──
  console.log("── buyer.agentPay() — RAW RESPONSE ──");
  const pay: AgentPayResponse = await buyer.agentPay(session.id, {
    payerEmail: "smoke@test.local",
  });
  console.log(JSON.stringify(pay, null, 2));
  console.log("");
  const transactionId = pay.transactionId;
  console.log("transactionId:", transactionId);
  console.log("");

  // ── poll getPayment until terminal — RAW LOG EACH ──
  console.log("── buyer.getPayment() polling (every 2s, max 60s) ──");
  const statusTrail: Array<{ at: string; status: string; tx_hash?: string | null }> = [];
  const polledRaw: PaymentStatus[] = [];
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let final: PaymentStatus | null = null;
  while (Date.now() < deadline) {
    const status = await buyer.getPayment(transactionId);
    polledRaw.push(status);
    const txAny = status.tx_hash ?? status.txHash ?? null;
    statusTrail.push({
      at: new Date().toISOString(),
      status: status.status,
      tx_hash: txAny,
    });
    console.log(
      `[${new Date().toISOString()}] status=${status.status}` +
        (txAny ? ` tx_hash=${txAny}` : ""),
    );
    const upper = String(status.status).toUpperCase();
    if (upper === "CONFIRMED" || upper === "FAILED" || upper === "POLICY_REJECTED") {
      final = status;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!final) {
    console.error("polling timed out before terminal status");
    process.exit(1);
  }
  console.log("");
  console.log("── final getPayment response — RAW ──");
  console.log(JSON.stringify(final, null, 2));
  console.log("");

  if (String(final.status).toUpperCase() !== "CONFIRMED") {
    console.error(`payment terminal but not CONFIRMED: ${final.status}`);
    process.exit(1);
  }

  // ── balances after ──
  console.log("── balances after ──");
  const buyerAfter = await buyer.balance();
  const merchantAfter = await merchant.balance();
  const buyerDelta =
    Number(buyerBefore.usdc_balance) - Number(buyerAfter.usdc_balance);
  const merchantDelta =
    Number(merchantAfter.usdc_balance) - Number(merchantBefore.usdc_balance);
  console.log(
    `merchant: ${fmt$(Number(merchantBefore.usdc_balance))} → ${fmt$(Number(merchantAfter.usdc_balance))} (Δ +${fmt$(merchantDelta)})`,
  );
  console.log(
    `buyer   : ${fmt$(Number(buyerBefore.usdc_balance))} → ${fmt$(Number(buyerAfter.usdc_balance))} (Δ -${fmt$(buyerDelta)})`,
  );
  console.log("");

  // ── verification table ──
  console.log("── verification table ──");
  console.log("");
  printVerification({
    pay,
    final,
    polledRaw,
    statusTrail,
    sessionId: session.id,
  });

  // ── persist ──
  const resultPath = resolve(__dirname, "smoke-pay-result.json");
  const result = {
    timestamp: new Date().toISOString(),
    apiBase,
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
    preflight: pre,
    agentPay: pay,
    polled: polledRaw,
    finalPayment: final,
    statusTrail,
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log("");
  console.log(`Wrote ${resultPath}`);
  console.log("");
  console.log(`Spend: ${fmt$(buyerDelta)} (buyer side, includes any Locus fee)`);
  console.log("Done.");
}

function printVerification(args: {
  pay: AgentPayResponse;
  final: PaymentStatus;
  polledRaw: PaymentStatus[];
  statusTrail: Array<{ at: string; status: string; tx_hash?: string | null }>;
  sessionId: string;
}): void {
  const payObj = args.pay as unknown as Record<string, unknown>;
  const finalObj = args.final as unknown as Record<string, unknown>;

  const allStatuses = [...new Set(args.polledRaw.map((p) => p.status))];
  const firstSeenWithTx = args.polledRaw.find(
    (p) => !!(p.tx_hash ?? p.txHash),
  );

  const rows: Array<[string, string, string, string]> = [
    ["Field", "Spec'd in client.ts", "Actual from Locus", "Action needed"],
    ["---", "---", "---", "---"],
  ];

  // agentPay top-level keys (CONFIRMED LIVE 2026-04-30: camelCase)
  rows.push([
    "agentPay() raw response keys (CONFIRMED LIVE)",
    "transactionId, queueJobId, status, sessionId, amount, currency, statusEndpoint, message? (camel)",
    Object.keys(payObj).join(", "),
    "compare",
  ]);
  rows.push([
    "agentPay().transactionId",
    "string",
    `${typeof payObj["transactionId"]} (${JSON.stringify(payObj["transactionId"])})`,
    typeof payObj["transactionId"] === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "agentPay().status",
    'lowercase enum: queued|processing|confirmed|failed|policy_rejected',
    JSON.stringify(payObj["status"]),
    "compare against payments enum",
  ]);
  rows.push([
    "agentPay().sessionId",
    "string (matches input sessionId)",
    `${typeof payObj["sessionId"]} (${JSON.stringify(payObj["sessionId"])})`,
    payObj["sessionId"] === args.sessionId ? "ok (matches)" : "MISMATCH — verify",
  ]);
  rows.push([
    "agentPay().queueJobId",
    "string",
    payObj["queueJobId"] === undefined
      ? "(absent)"
      : `${typeof payObj["queueJobId"]} (${JSON.stringify(payObj["queueJobId"])})`,
    "verify",
  ]);
  rows.push([
    "agentPay().amount",
    "Money (string)",
    `${typeof payObj["amount"]} (${JSON.stringify(payObj["amount"])})`,
    typeof payObj["amount"] === "string" ? "ok" : "update type",
  ]);
  rows.push([
    "agentPay().currency",
    "string",
    `${typeof payObj["currency"]} (${JSON.stringify(payObj["currency"])})`,
    typeof payObj["currency"] === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "agentPay().statusEndpoint",
    "string (convenience path)",
    `${typeof payObj["statusEndpoint"]} (${JSON.stringify(payObj["statusEndpoint"])})`,
    "ok (we ignore it)",
  ]);

  // agentPay casing audit
  const payKeys = Object.keys(payObj);
  const paySnake = payKeys.filter((k) => k.includes("_"));
  const payCamel = payKeys.filter((k) => !k.includes("_") && /[A-Z]/.test(k));
  rows.push([
    "agentPay() casing",
    "camelCase",
    paySnake.length && !payCamel.length
      ? "snake (need to flip type back)"
      : payCamel.length && !paySnake.length
        ? "camel (matches)"
        : `mixed: snake=[${paySnake.join(",")}] camel=[${payCamel.join(",")}]`,
    payCamel.length && !paySnake.length
      ? "ok"
      : "update AgentPayResponse type",
  ]);

  // getPayment top-level keys — type is dual-cased pending this smoke.
  rows.push([
    "getPayment() raw response keys",
    "(dual-cased pending: id|transactionId, amount_usdc|amountUsdc, tx_hash|txHash, block_number|blockNumber, created_at|createdAt)",
    Object.keys(finalObj).join(", "),
    "collapse to confirmed casing",
  ]);
  rows.push([
    "getPayment() id field name",
    "id OR transactionId (dual)",
    typeof finalObj["id"] === "string"
      ? `id=${JSON.stringify(finalObj["id"])}`
      : typeof finalObj["transactionId"] === "string"
        ? `transactionId=${JSON.stringify(finalObj["transactionId"])}`
        : "(neither present!)",
    "lock to confirmed name",
  ]);
  rows.push([
    "getPayment() id matches agentPay.transactionId",
    "(should match)",
    (finalObj["id"] ?? finalObj["transactionId"]) === args.pay.transactionId
      ? "ok"
      : "MISMATCH — verify",
    "verify",
  ]);
  rows.push([
    "getPayment().status enum values observed",
    "(unknown casing — both lowercase + UPPERCASE acceptable for now)",
    allStatuses.join(", "),
    "lock the enum + casing",
  ]);
  rows.push([
    "getPayment() amount field",
    "amount_usdc OR amountUsdc (dual)",
    finalObj["amount_usdc"] !== undefined
      ? `amount_usdc=${JSON.stringify(finalObj["amount_usdc"])}`
      : finalObj["amountUsdc"] !== undefined
        ? `amountUsdc=${JSON.stringify(finalObj["amountUsdc"])}`
        : "(neither present)",
    "lock to confirmed name + type",
  ]);
  rows.push([
    "getPayment() tx_hash present at status",
    "(unspecified — check)",
    firstSeenWithTx
      ? `first at status=${firstSeenWithTx.status}: ${firstSeenWithTx.tx_hash ?? firstSeenWithTx.txHash}`
      : "(never observed)",
    firstSeenWithTx ? "ok" : "tx_hash never returned — investigate",
  ]);
  rows.push([
    "getPayment() block_number/blockNumber",
    "optional number (dual)",
    finalObj["block_number"] !== undefined
      ? `block_number=${JSON.stringify(finalObj["block_number"])}`
      : finalObj["blockNumber"] !== undefined
        ? `blockNumber=${JSON.stringify(finalObj["blockNumber"])}`
        : "(absent)",
    "collapse",
  ]);
  rows.push([
    "getPayment() created_at/createdAt",
    "string ISO (dual)",
    finalObj["created_at"] !== undefined
      ? `created_at=${JSON.stringify(finalObj["created_at"])}`
      : finalObj["createdAt"] !== undefined
        ? `createdAt=${JSON.stringify(finalObj["createdAt"])}`
        : "(absent)",
    "collapse",
  ]);

  // getPayment casing
  const getKeys = Object.keys(finalObj);
  const getSnake = getKeys.filter((k) => k.includes("_"));
  const getCamel = getKeys.filter((k) => !k.includes("_") && /[A-Z]/.test(k));
  rows.push([
    "getPayment() casing",
    "(unknown — dual-cased type until this smoke confirms)",
    getSnake.length && !getCamel.length
      ? "snake_case"
      : getCamel.length && !getSnake.length
        ? "camelCase"
        : getSnake.length && getCamel.length
          ? `mixed: snake=[${getSnake.join(",")}] camel=[${getCamel.join(",")}]`
          : "(no snake or camel keys — single-word only)",
    "collapse PaymentStatus type",
  ]);

  // Envelope detection — our client unwraps both wrapped and flat. We can
  // infer indirectly: if the raw response had `success` key visible, it'd
  // appear post-unwrap... it doesn't, which means our client's flat-strip
  // worked. Note this in the table.
  rows.push([
    "agentPay envelope shape",
    "wrapped {success,data} OR flat {success,...fields}",
    Object.keys(payObj).includes("success")
      ? "FLAT (success leaked through unwrap)"
      : "wrapped or flat — both unwrapped cleanly",
    Object.keys(payObj).includes("success")
      ? "investigate unwrap"
      : "ok",
  ]);
  rows.push([
    "getPayment envelope shape",
    "wrapped {success,data} OR flat {success,...fields}",
    Object.keys(finalObj).includes("success")
      ? "FLAT (success leaked through unwrap)"
      : "wrapped or flat — both unwrapped cleanly",
    Object.keys(finalObj).includes("success")
      ? "investigate unwrap"
      : "ok",
  ]);

  // Status trail
  rows.push([
    "status transitions observed",
    "QUEUED → PROCESSING → CONFIRMED",
    args.statusTrail.map((s) => s.status).join(" → "),
    "compare",
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
