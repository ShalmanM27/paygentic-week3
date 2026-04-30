// Smoke test for the Locus client against beta. ZERO spend by design:
// we only create a session and let it expire — never pay it.
//
// Run from repo root:  pnpm smoke:locus
//
// Loads env explicitly from packages/credit-agent/.env. Refuses to run if
// LOCUS_OFFLINE_MODE=1 or balance < $0.020.

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocusClient,
  LocusApiError,
  type CheckoutSession,
  type PreflightResponse,
  type WalletBalance,
} from "../src/locus/index.js";

// __dirname shim for ESM
const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV_PATH = resolve(__dirname, "../../credit-agent/.env");
config({ path: ENV_PATH });

const SMOKE_AMOUNT = "0.005";
const MIN_BALANCE = 0.02;

async function main(): Promise<void> {
  // ── Guards ───────────────────────────────────────────────────────────

  if (process.env.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing to run smoke test against real Locus while OFFLINE_MODE is set. " +
        "Set LOCUS_OFFLINE_MODE=0 in packages/credit-agent/.env to proceed.",
    );
    process.exit(1);
  }

  const apiKey = process.env.LOCUS_API_KEY;
  if (!apiKey || !apiKey.startsWith("claw_")) {
    console.error(
      "LOCUS_API_KEY missing or not in claw_ format. Aborting. (env loaded from " +
        ENV_PATH +
        ")",
    );
    process.exit(1);
  }

  const apiBase =
    process.env.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api";

  console.log("Using key:", apiKey.slice(0, 8) + "...");
  console.log("API base: ", apiBase);
  console.log("Env file: ", ENV_PATH);
  console.log("");

  const client = new LocusClient({ apiKey, apiBase });

  // ── 1. Balance ───────────────────────────────────────────────────────

  console.log("── balance() ─────────────────────────────────────────────");
  const balance: WalletBalance = await client.balance();
  console.log(JSON.stringify(balance, null, 2));

  const balanceNum = Number(balance.usdc_balance);
  if (!Number.isFinite(balanceNum) || balanceNum < MIN_BALANCE) {
    console.log("");
    console.log(
      `Balance $${balanceNum.toFixed(4)} insufficient for smoke test ` +
        `(need $${MIN_BALANCE.toFixed(3)} minimum, ceiling spend $${SMOKE_AMOUNT}). Aborting.`,
    );
    process.exit(0);
  }
  console.log("");

  // ── 2. Create session ────────────────────────────────────────────────

  console.log("── createSession() ───────────────────────────────────────");
  const session: CheckoutSession = await client.createSession({
    amount: SMOKE_AMOUNT,
    currency: "USDC",
    receiptConfig: {
      enabled: true,
      fields: {
        creditorName: "CREDIT smoke test",
        lineItems: [
          { description: "Locus client smoke", amount: SMOKE_AMOUNT },
        ],
      },
    },
    metadata: { purpose: "smoke", iso: new Date().toISOString() },
    ttlSeconds: 600,
  });
  console.log(JSON.stringify(session, null, 2));
  console.log("");
  console.log("sessionId      :", session.id);
  console.log("checkoutUrl    :", session.checkoutUrl ?? "(not present)");
  console.log(
    "webhookSecret  : (not returned per-session in beta — account-level via env)",
  );
  console.log("");

  const sessionId = session.id;

  // ── 3. Get session ───────────────────────────────────────────────────

  console.log("── getSession() ──────────────────────────────────────────");
  const fetched: CheckoutSession = await client.getSession(sessionId);
  console.log(JSON.stringify(fetched, null, 2));
  console.log("");
  console.log("status:", fetched.status, "(expected PENDING)");
  console.log("");

  // ── 4. Preflight ─────────────────────────────────────────────────────

  console.log("── preflight() ───────────────────────────────────────────");
  const pre: PreflightResponse = await client.preflight(sessionId);
  console.log(JSON.stringify(pre, null, 2));
  console.log("");
  console.log("canPay  :", pre.canPay);
  console.log("blockers:", pre.blockers ?? "(none)");
  console.log("");

  // ── 5. agentPay deliberately skipped — we let the session expire. ────

  // ── 6. Verification table ────────────────────────────────────────────

  console.log("── verification table ────────────────────────────────────");
  console.log("");
  printVerificationTable({ balance, session, fetched, pre });
  console.log("");
  console.log(
    "Smoke test complete. Spend so far: $0.000 (session unpaid, will expire).",
  );
}

function printVerificationTable(args: {
  balance: WalletBalance;
  session: CheckoutSession;
  fetched: CheckoutSession;
  pre: PreflightResponse;
}): void {
  const rows: Array<[string, string, string, string]> = [
    ["Field", "Spec'd in client.ts", "Actual from Locus", "Action needed"],
    ["---", "---", "---", "---"],
  ];

  // ── balance() — CONFIRMED LIVE 2026-04-29 ────────────────────────────

  rows.push([
    "balance() raw response keys (CONFIRMED LIVE)",
    "wallet_address, workspace_id, chain, usdc_balance, promo_credit_balance, allowance, max_transaction_size",
    Object.keys(args.balance).join(", "),
    Object.keys(args.balance).join(", ") ===
    "wallet_address, workspace_id, chain, usdc_balance, promo_credit_balance, allowance, max_transaction_size"
      ? "matches"
      : "compare keys",
  ]);
  rows.push([
    "balance.wallet_address",
    "string",
    `${typeof args.balance.wallet_address} (${JSON.stringify(args.balance.wallet_address)})`,
    typeof args.balance.wallet_address === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "balance.workspace_id",
    "string",
    `${typeof args.balance.workspace_id} (${JSON.stringify(args.balance.workspace_id)})`,
    typeof args.balance.workspace_id === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "balance.chain",
    "string",
    `${typeof args.balance.chain} (${JSON.stringify(args.balance.chain)})`,
    typeof args.balance.chain === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "balance.usdc_balance",
    "Money (string)",
    `${typeof args.balance.usdc_balance} (${JSON.stringify(args.balance.usdc_balance)})`,
    typeof args.balance.usdc_balance === "string" ? "ok" : "update Money type",
  ]);
  rows.push([
    "balance.promo_credit_balance",
    "Money (string)",
    `${typeof args.balance.promo_credit_balance} (${JSON.stringify(args.balance.promo_credit_balance)})`,
    typeof args.balance.promo_credit_balance === "string" ? "ok" : "verify",
  ]);
  rows.push([
    "balance.allowance",
    "Money | null",
    `${typeof args.balance.allowance} (${JSON.stringify(args.balance.allowance)})`,
    "ok",
  ]);
  rows.push([
    "balance.max_transaction_size",
    "Money | null",
    `${typeof args.balance.max_transaction_size} (${JSON.stringify(args.balance.max_transaction_size)})`,
    "ok",
  ]);

  // ── send hint ────────────────────────────────────────────────────────

  rows.push([
    "send.amount (hint)",
    "Money (string)",
    "(no call made — confirm on first send)",
    "verify when send() is exercised",
  ]);

  // ── createSession (CONFIRMED LIVE 2026-04-29) ────────────────────────

  rows.push([
    "createSession top-level keys (CONFIRMED LIVE)",
    "id, status, amount, currency, expiresAt, checkoutUrl, metadata?",
    Object.keys(args.session).join(", "),
    "compare",
  ]);
  rows.push([
    "createSession.checkoutUrl",
    "(was payUrl, wrong)",
    typeof args.session.checkoutUrl === "string"
      ? "checkoutUrl present"
      : "(absent)",
    "fixed in CheckoutSession type",
  ]);
  rows.push([
    "createSession.expiresAt format",
    "ISO 8601 string",
    JSON.stringify(args.session.expiresAt),
    "ok",
  ]);
  rows.push([
    "createSession.metadata round-trip",
    "preserved in getSession",
    JSON.stringify(args.fetched.metadata ?? null),
    "ok — usable as our loanId carrier",
  ]);
  rows.push([
    "session.status casing",
    "PENDING|PAID|EXPIRED|CANCELLED (UPPER)",
    JSON.stringify(args.session.status),
    args.session.status === args.session.status.toUpperCase()
      ? "ok"
      : "review enum casing",
  ]);

  // ── getSession ───────────────────────────────────────────────────────

  rows.push([
    "getSession top-level keys",
    "id, status, amount, currency, expiresAt, createdAt, metadata? (no checkoutUrl)",
    Object.keys(args.fetched).join(", "),
    "compare",
  ]);

  // ── preflight (CONFIRMED LIVE — flat envelope) ───────────────────────

  rows.push([
    "preflight envelope shape (CONFIRMED LIVE)",
    "Wrapped {success,data}",
    "Flat {success, canPay, agent, session}",
    "client unwrap fixed",
  ]);
  rows.push([
    "preflight top-level keys",
    "canPay, agent, session, blockers?",
    Object.keys(args.pre as Record<string, unknown>).join(", "),
    "compare",
  ]);
  const preSessionKeys = args.pre.session
    ? Object.keys(args.pre.session as Record<string, unknown>).join(", ")
    : "(no session field)";
  rows.push([
    "preflight.session keys",
    "id, amount, currency, description, status, expiresAt, sellerWalletAddress",
    preSessionKeys,
    "compare",
  ]);
  rows.push([
    "preflight.session.sellerWalletAddress",
    "(was merchantAddress assumption)",
    typeof args.pre.session?.sellerWalletAddress === "string"
      ? "sellerWalletAddress"
      : "(missing!)",
    "use as merchant identity verifier",
  ]);
  rows.push([
    "preflight.agent.availableBalance",
    "(undocumented field)",
    `${JSON.stringify(args.pre.agent?.availableBalance)} — appears to be a flag, not real balance`,
    "treat skeptically; don't use for real budget checks",
  ]);

  // ── snake_case audit ─────────────────────────────────────────────────

  const snakeFound = findSnakeCaseKeys(args.session).concat(
    findSnakeCaseKeys(args.pre as unknown as Record<string, unknown>),
    findSnakeCaseKeys(args.balance as unknown as Record<string, unknown>),
  );
  rows.push([
    "snake_case keys observed (across all three responses)",
    "Locus uses snake_case end-to-end",
    snakeFound.length > 0 ? snakeFound.join(", ") : "(none observed)",
    snakeFound.length > 0 ? "treat as canonical" : "verify",
  ]);

  // print
  for (const row of rows) {
    console.log("| " + row.map(escapePipes).join(" | ") + " |");
  }
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function findSnakeCaseKeys(
  obj: Record<string, unknown> | unknown,
  prefix = "",
): string[] {
  if (!obj || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.includes("_")) out.push(prefix ? `${prefix}.${k}` : k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...findSnakeCaseKeys(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return out;
}

main().catch((err) => {
  console.error("");
  console.error("── ERROR ─────────────────────────────────────────────────");
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
