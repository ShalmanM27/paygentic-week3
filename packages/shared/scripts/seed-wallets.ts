// One-shot seeding script. Transfers USDC from credit-agent → 3 other wallets.
// Doubles as the live smoke test for client.send() and confirms the
// POST /pay/send response shape against beta.
//
// Run from repo root:  pnpm seed:wallets
//
// Loads each service's .env SEPARATELY via dotenv.parse so process.env is
// not clobbered. Hard-coded amounts. $1.50 lending-pool floor enforced.

import { parse } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocusClient,
  LocusApiError,
  type SendUsdcResponse,
  type WalletBalance,
} from "../src/locus/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");

// ── Hard-coded transfer plan ──────────────────────────────────────────
const TRANSFERS = [
  { name: "borrower-a", envFile: "packages/borrower-a/.env",     amount: 0.05, memo: "CREDIT seed: A" },
  { name: "borrower-b", envFile: "packages/borrower-b/.env",     amount: 0.03, memo: "CREDIT seed: B" },
  { name: "customer",   envFile: "packages/customer-agent/.env", amount: 0.05, memo: "CREDIT seed: customer" },
] as const;

const POOL_FLOOR = 1.50;
const TOTAL_OUT = TRANSFERS.reduce((s, t) => s + t.amount, 0); // 0.13
const MIN_REQUIRED = TOTAL_OUT + POOL_FLOOR;                    // 1.63
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60_000;
const APPROX_TOLERANCE = 0.0005; // permit fee deduction

// ── Helpers ───────────────────────────────────────────────────────────

function loadEnv(relPath: string): Record<string, string> {
  const abs = resolve(ROOT, relPath);
  return parse(readFileSync(abs, "utf8"));
}

function fmt$(n: number): string {
  return `$${n.toFixed(4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("seed-wallets — one-shot transfer from credit-agent → 3 wallets");
  console.log("");

  // ── Guard 1: offline mode ───────────────────────────────────────────
  const creditEnv = loadEnv("packages/credit-agent/.env");
  if (creditEnv.LOCUS_OFFLINE_MODE === "1") {
    console.error(
      "Refusing to run — LOCUS_OFFLINE_MODE=1 in packages/credit-agent/.env. " +
        "Set to 0 to proceed.",
    );
    process.exit(1);
  }

  const creditKey = creditEnv.LOCUS_API_KEY;
  const apiBase =
    creditEnv.LOCUS_API_BASE ?? "https://beta-api.paywithlocus.com/api";
  if (!creditKey || !creditKey.startsWith("claw_")) {
    console.error("credit-agent LOCUS_API_KEY missing or not claw_ format.");
    process.exit(1);
  }

  // ── Guard 2: load + validate the 3 recipient keys ───────────────────
  const recipients = TRANSFERS.map((t) => {
    const env = loadEnv(t.envFile);
    const key = env.LOCUS_API_KEY;
    if (!key || !key.startsWith("claw_")) {
      console.error(`${t.name} LOCUS_API_KEY missing or not claw_ format`);
      process.exit(1);
    }
    if (key === creditKey) {
      console.error(
        `${t.name} LOCUS_API_KEY is identical to credit-agent key — ` +
          `looks like a copy-paste. Refusing.`,
      );
      process.exit(1);
    }
    return { ...t, key };
  });

  // ── Phase 1: discovery ──────────────────────────────────────────────
  console.log("── Phase 1: discovery (read all balances) ────────────────");
  const creditClient = new LocusClient({ apiKey: creditKey, apiBase });
  const creditBalanceBefore = await creditClient.balance();
  console.log("credit-agent:");
  console.log("  address:", creditBalanceBefore.wallet_address);
  console.log("  balance:", fmt$(Number(creditBalanceBefore.usdc_balance)));

  const recipientInfos: Array<{
    name: string;
    amount: number;
    memo: string;
    key: string;
    client: LocusClient;
    addressBefore: string;
    balanceBefore: WalletBalance;
  }> = [];

  for (const r of recipients) {
    const c = new LocusClient({ apiKey: r.key, apiBase });
    const bal = await c.balance();
    console.log(`${r.name}:`);
    console.log("  address:", bal.wallet_address);
    console.log("  balance:", fmt$(Number(bal.usdc_balance)));
    recipientInfos.push({
      name: r.name,
      amount: r.amount,
      memo: r.memo,
      key: r.key,
      client: c,
      addressBefore: bal.wallet_address,
      balanceBefore: bal,
    });
  }
  console.log("");

  // ── Guard 3: pool floor ─────────────────────────────────────────────
  const creditBalNum = Number(creditBalanceBefore.usdc_balance);
  if (!Number.isFinite(creditBalNum) || creditBalNum < MIN_REQUIRED) {
    console.error(
      `credit-agent balance ${fmt$(creditBalNum)} below required minimum ` +
        `${fmt$(MIN_REQUIRED)} (transfers ${fmt$(TOTAL_OUT)} + floor ${fmt$(POOL_FLOOR)}). ` +
        `Aborting.`,
    );
    process.exit(1);
  }

  // ── Phase 2: confirmation gate ──────────────────────────────────────
  console.log("── Phase 2: plan ─────────────────────────────────────────");
  console.log("");
  console.log(
    `FROM credit-agent (${creditBalanceBefore.wallet_address.slice(0, 10)}...)`,
  );
  for (const r of recipientInfos) {
    console.log(
      `  → ${r.name.padEnd(11)} (${r.addressBefore.slice(0, 10)}...) : ${fmt$(r.amount)}`,
    );
  }
  console.log(`  TOTAL OUT                                  : ${fmt$(TOTAL_OUT)}`);
  console.log(`  CREDIT-AGENT BEFORE                        : ${fmt$(creditBalNum)}`);
  console.log(
    `  CREDIT-AGENT AFTER (estimated, pre-fee)    : ${fmt$(creditBalNum - TOTAL_OUT)}`,
  );
  console.log("");
  console.log("Press Ctrl+C now to abort. Proceeding in 5 seconds…");
  await sleep(5000);
  console.log("");

  // ── Phase 3: execute (serial) ───────────────────────────────────────
  console.log("── Phase 3: execute transfers (serial) ───────────────────");
  const sendResponses: Array<{
    name: string;
    request: { to_address: string; amount: number; memo: string };
    response: SendUsdcResponse;
    confirmed: boolean;
    confirmedAfter: WalletBalance | null;
  }> = [];

  for (const r of recipientInfos) {
    console.log("");
    console.log(`>>> sending ${fmt$(r.amount)} → ${r.name} (${r.addressBefore})`);
    const reqBody = {
      toAddress: r.addressBefore,
      amount: r.amount,
      memo: r.memo,
    };
    let response: SendUsdcResponse;
    try {
      response = await creditClient.send(reqBody);
    } catch (err) {
      console.error("send() FAILED:", err);
      throw err;
    }
    console.log("response:", JSON.stringify(response, null, 2));

    // Poll recipient balance until it increases by ~amount or we time out.
    const targetMin = Number(r.balanceBefore.usdc_balance) + r.amount - APPROX_TOLERANCE;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let confirmedAfter: WalletBalance | null = null;
    let confirmed = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const cur = await r.client.balance();
        const curNum = Number(cur.usdc_balance);
        process.stdout.write(`  poll ${r.name}: ${fmt$(curNum)} (target ≥ ${fmt$(targetMin)})\n`);
        if (curNum >= targetMin) {
          confirmedAfter = cur;
          confirmed = true;
          break;
        }
      } catch (err) {
        console.warn(`  poll error for ${r.name}:`, err);
      }
    }
    if (!confirmed) {
      console.warn(`  WARN: ${r.name} did not confirm within ${POLL_TIMEOUT_MS}ms.`);
    } else {
      console.log(`  ✓ ${r.name} confirmed`);
    }
    sendResponses.push({
      name: r.name,
      request: {
        to_address: r.addressBefore,
        amount: r.amount,
        memo: r.memo,
      },
      response,
      confirmed,
      confirmedAfter,
    });
  }

  // ── Phase 4: verification ───────────────────────────────────────────
  console.log("");
  console.log("── Phase 4: verification (re-read all balances) ──────────");
  const creditAfter = await creditClient.balance();
  const recipientFinal: Array<{ name: string; balance: WalletBalance }> = [];
  for (const r of recipientInfos) {
    recipientFinal.push({ name: r.name, balance: await r.client.balance() });
  }

  const beforeAfterRows: Array<[string, string, string, string]> = [
    ["wallet", "address", "before", "after"],
    ["---", "---", "---", "---"],
    [
      "credit-agent",
      creditBalanceBefore.wallet_address,
      fmt$(Number(creditBalanceBefore.usdc_balance)),
      fmt$(Number(creditAfter.usdc_balance)),
    ],
  ];
  for (let i = 0; i < recipientInfos.length; i++) {
    const r = recipientInfos[i]!;
    const after = recipientFinal[i]!.balance;
    beforeAfterRows.push([
      r.name,
      r.addressBefore,
      fmt$(Number(r.balanceBefore.usdc_balance)),
      fmt$(Number(after.usdc_balance)),
    ]);
  }
  console.log("");
  for (const row of beforeAfterRows) {
    console.log("| " + row.join(" | ") + " |");
  }
  console.log("");

  // ── Phase 4b: persist seed-result.json ──────────────────────────────
  const resultPath = resolve(__dirname, "seed-result.json");
  const result = {
    timestamp: new Date().toISOString(),
    apiBase,
    wallets: {
      "credit-agent": {
        address: creditBalanceBefore.wallet_address,
        balanceBefore: creditBalanceBefore.usdc_balance,
        balanceAfter: creditAfter.usdc_balance,
      },
      ...Object.fromEntries(
        recipientInfos.map((r, i) => [
          r.name,
          {
            address: r.addressBefore,
            balanceBefore: r.balanceBefore.usdc_balance,
            balanceAfter: recipientFinal[i]!.balance.usdc_balance,
          },
        ]),
      ),
    },
    transfers: sendResponses,
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${resultPath}`);

  // ── Phase 5: send() verification (all three responses) ──────────────
  console.log("");
  console.log("── Phase 5: send() shape verification ────────────────────");
  console.log("");
  for (const sr of sendResponses) {
    console.log(`── send() response: ${sr.name} ──`);
    console.log(JSON.stringify(sr.response, null, 2));
    console.log("");
  }
  printDedupedSendTable(sendResponses);

  // ── Phase 6: update CLAUDE.md "Wallet registry (seeded)" ────────────
  await updateClaudeMdRegistry({
    creditAgent: {
      address: creditBalanceBefore.wallet_address,
      balanceAfter: creditAfter.usdc_balance,
    },
    recipients: recipientInfos.map((r, i) => ({
      name: r.name,
      address: r.addressBefore,
      balanceAfter: recipientFinal[i]!.balance.usdc_balance,
    })),
    transfers: sendResponses,
  });

  console.log("");
  console.log("Done.");
}

// Collect each field across all three responses; emit one row per field
// per distinct (type, valuePattern) — so identical values dedupe to one row,
// and any divergence shows as multiple rows tagged with the diverging names.
function printDedupedSendTable(
  sendResponses: Array<{
    name: string;
    response: SendUsdcResponse;
  }>,
): void {
  const objs = sendResponses.map(
    (s) => [s.name, s.response as unknown as Record<string, unknown>] as const,
  );

  const allKeys = new Set<string>();
  for (const [, obj] of objs) for (const k of Object.keys(obj)) allKeys.add(k);

  const rows: Array<[string, string, string, string]> = [
    ["Field", "Spec'd in client.ts", "Actual from Locus (deduped across A/B/customer)", "Action needed"],
    ["---", "---", "---", "---"],
  ];

  // Top-level key list per response
  for (const [name, obj] of objs) {
    rows.push([
      `[${name}] raw response keys`,
      "transaction_id, queue_job_id, status, from_address, to_address, amount, token (snake)",
      Object.keys(obj).join(", "),
      "compare",
    ]);
  }

  // Casing audit: a single verdict that uses all three
  const allKeyLists = objs.map(([, o]) => Object.keys(o));
  const anySnake = allKeyLists.some((ks) => ks.some((k) => k.includes("_")));
  const anyCamel = allKeyLists.some((ks) =>
    ks.some((k) => !k.includes("_") && /[A-Z]/.test(k)),
  );
  rows.push([
    "send() casing",
    "snake_case (per docs example)",
    anySnake && !anyCamel
      ? "snake_case (matches)"
      : anyCamel && !anySnake
        ? "camelCase (need to flip type)"
        : "mixed snake/camel — see per-key rows",
    anySnake && !anyCamel ? "ok" : "update SendUsdcResponse type",
  ]);

  // Per-field deduped rows. Group by (type + serialized value).
  const fieldsToInspect = [
    "transaction_id",
    "queue_job_id",
    "status",
    "from_address",
    "to_address",
    "amount",
    "token",
  ];
  for (const field of fieldsToInspect) {
    const groups = new Map<string, string[]>();
    for (const [name, obj] of objs) {
      const v = obj[field];
      const key = `${typeof v}:${JSON.stringify(v)}`;
      const arr = groups.get(key) ?? [];
      arr.push(name);
      groups.set(key, arr);
    }
    if (groups.size === 1) {
      const [key] = [...groups.keys()];
      const [tipe, ...rest] = key!.split(":");
      const valStr = rest.join(":");
      rows.push([
        `send().${field}`,
        specForField(field),
        `${tipe} ${valStr} (all match)`,
        actionForField(field, tipe!, valStr),
      ]);
    } else {
      for (const [key, names] of groups) {
        const [tipe, ...rest] = key.split(":");
        const valStr = rest.join(":");
        rows.push([
          `send().${field}`,
          specForField(field),
          `[${names.join(",")}] ${tipe} ${valStr}`,
          "DIVERGES — review per-recipient",
        ]);
      }
    }
  }

  // Capture any unexpected fields (anything in allKeys not in fieldsToInspect)
  const extras = [...allKeys].filter((k) => !fieldsToInspect.includes(k));
  if (extras.length > 0) {
    rows.push([
      "send() unexpected fields",
      "(none)",
      extras.join(", "),
      "consider adding to SendUsdcResponse",
    ]);
  }

  for (const row of rows) {
    console.log("| " + row.map((s) => s.replace(/\|/g, "\\|")).join(" | ") + " |");
  }
}

function specForField(f: string): string {
  switch (f) {
    case "transaction_id":
    case "queue_job_id":
    case "from_address":
    case "to_address":
      return "string";
    case "status":
      return "string (PROCESSING|QUEUED|CONFIRMED|...)";
    case "amount":
      return "Money (string)";
    case "token":
      return '"USDC"';
    default:
      return "(unspecified)";
  }
}

function actionForField(f: string, tipe: string, valStr: string): string {
  if (f === "amount" && tipe !== "string") {
    return "amount typed as " + tipe + " — update Money policy";
  }
  if (f === "token" && valStr !== '"USDC"') {
    return "token != USDC — verify";
  }
  if ((f === "transaction_id" || f === "from_address" || f === "to_address") && tipe !== "string") {
    return "verify";
  }
  return "ok";
}

// ── CLAUDE.md "Wallet registry (seeded)" updater ──────────────────────
//
// Inserts or replaces the section AFTER "## Wire format observations …".
// Preserves all other content. Idempotent — repeat runs replace, not stack.
async function updateClaudeMdRegistry(args: {
  creditAgent: { address: string; balanceAfter: string };
  recipients: Array<{ name: string; address: string; balanceAfter: string }>;
  transfers: Array<{
    name: string;
    response: SendUsdcResponse;
  }>;
}): Promise<void> {
  const claudePath = resolve(ROOT, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    console.warn(`CLAUDE.md not found at ${claudePath} — skipping registry update.`);
    return;
  }
  const original = readFileSync(claudePath, "utf8");

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const txByName = new Map<string, SendUsdcResponse>();
  for (const t of args.transfers) txByName.set(t.name, t.response);

  const lines: string[] = [];
  lines.push("## Wallet registry (seeded)");
  lines.push("");
  lines.push(`Seeded on **${date}**.`);
  lines.push("");
  lines.push("| Agent | Wallet address | Final balance | Seeding tx |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| credit-agent | \`${args.creditAgent.address}\` | ${args.creditAgent.balanceAfter} USDC | (sender) |`,
  );
  for (const r of args.recipients) {
    const tx = txByName.get(r.name);
    const txId =
      tx && typeof (tx as unknown as Record<string, unknown>)["transaction_id"] === "string"
        ? `\`${(tx as unknown as Record<string, unknown>)["transaction_id"] as string}\``
        : "(unknown)";
    lines.push(
      `| ${r.name} | \`${r.address}\` | ${r.balanceAfter} USDC | ${txId} |`,
    );
  }
  lines.push("");
  lines.push(
    "These addresses are canonical. Future scripts and runtime code should treat this table as the source of truth — do not re-derive from `.env`.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  const newSection = lines.join("\n");

  // Marker: insert after "## Wire format observations" section ends
  // (i.e. before the "---" delimiter that precedes "## Tech Stack").
  // We find the next "## " heading after "## Wire format observations" and
  // the "---" line that immediately precedes it; insert before that "---".
  //
  // To make it idempotent, first strip any existing "## Wallet registry (seeded)"
  // block (from "## Wallet registry" up to and including the trailing "---\n").

  let working = original;
  const existingStart = working.indexOf("## Wallet registry (seeded)");
  if (existingStart !== -1) {
    // find the next "---" line after the section start, then advance past it
    const afterMarker = working.indexOf("\n---\n", existingStart);
    if (afterMarker !== -1) {
      const cutEnd = afterMarker + "\n---\n".length;
      working = working.slice(0, existingStart) + working.slice(cutEnd);
    }
  }

  const wireIdx = working.indexOf("## Wire format observations");
  if (wireIdx === -1) {
    console.warn(
      'CLAUDE.md does not contain "## Wire format observations" — appending registry at end.',
    );
    const out = working.replace(/\s*$/, "\n\n") + newSection;
    writeFileSync(claudePath, out);
    console.log("Appended Wallet registry to CLAUDE.md (end of file).");
    return;
  }

  // Find the next top-level heading after the wire section.
  const nextHeadingIdx = working.indexOf("\n## ", wireIdx + 1);
  if (nextHeadingIdx === -1) {
    const out = working.replace(/\s*$/, "\n\n") + newSection;
    writeFileSync(claudePath, out);
    console.log("Appended Wallet registry to CLAUDE.md (end of file).");
    return;
  }

  // Walk back from the next heading through any blank lines + "---" delimiter.
  let insertAt = nextHeadingIdx + 1; // position of the "## " char
  // back up over "\n---\n" if present
  const dashSlice = working.slice(Math.max(0, insertAt - 6), insertAt);
  if (dashSlice.endsWith("---\n")) {
    insertAt = insertAt - 4; // back up to the "---\n" line
    // also back up the leading newline before "---"
    while (insertAt > 0 && working[insertAt - 1] === "\n") insertAt--;
    // re-add a single newline so we end up cleanly between sections
    insertAt = insertAt + 1;
  }

  const out =
    working.slice(0, insertAt) + newSection + working.slice(insertAt);
  writeFileSync(claudePath, out);
  console.log(
    `Updated CLAUDE.md — Wallet registry section ${
      existingStart !== -1 ? "replaced" : "inserted"
    } after Wire format observations.`,
  );
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
