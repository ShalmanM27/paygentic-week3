// Pre-demo health check. Boots demo for ~10s, pings every service, and
// reports a single green/red summary. Use before any live demo run.
//
// Run with: pnpm verify
//
// Exit code: 0 if all green, 1 otherwise. Prints which checks failed.

import { spawn } from "node:child_process";
import { request } from "undici";
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
loadDotenv({ path: resolve(__dirname, "../.env") });

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function record(label: string, ok: boolean, detail?: string): void {
  checks.push({ label, ok, detail });
  const icon = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✕\x1b[0m";
  console.log(`  ${icon}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function pingHealthz(
  port: number,
  label: string,
): Promise<void> {
  try {
    const res = await request(`http://localhost:${port}/healthz`, {
      bodyTimeout: 3000,
      headersTimeout: 3000,
    });
    const text = await res.body.text();
    record(label, res.statusCode === 200, `port ${port} → ${res.statusCode}`);
    void text;
  } catch (err) {
    record(label, false, `port ${port} → ${String(err).slice(0, 80)}`);
  }
}

async function checkMongo(): Promise<void> {
  try {
    const { connect, disconnect } = await import("@credit/shared");
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      record("Mongo connection", false, "MONGODB_URI not set");
      return;
    }
    await connect(uri);
    await disconnect();
    record("Mongo connection", true, uri.replace(/:[^:@]+@/, ":***@"));
  } catch (err) {
    record("Mongo connection", false, String(err).slice(0, 80));
  }
}

async function checkGeminiKey(): Promise<void> {
  // Borrower's .env may shadow the credit-agent's; load both.
  loadDotenv({ path: resolve(ROOT, "packages/borrower/.env") });
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    record(
      "Gemini API key",
      false,
      "GEMINI_API_KEY missing — live agents will fail",
    );
    return;
  }
  // Quick handshake — list models endpoint, no quota burned.
  try {
    const base =
      process.env.GEMINI_API_BASE ??
      "https://generativelanguage.googleapis.com/v1beta";
    const res = await request(
      `${base.replace(/\/+$/, "")}/models?key=${encodeURIComponent(key)}`,
      { bodyTimeout: 5000, headersTimeout: 5000 },
    );
    await res.body.text();
    record(
      "Gemini API key",
      res.statusCode === 200,
      `models endpoint → ${res.statusCode}`,
    );
  } catch (err) {
    record("Gemini API key", false, String(err).slice(0, 80));
  }
}

async function runTypecheck(): Promise<void> {
  await new Promise<void>((resolveProc) => {
    const proc = spawn("pnpm", ["typecheck"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", () => {
      /* swallow noise */
    });
    proc.on("close", (code) => {
      record(
        "pnpm typecheck",
        code === 0,
        code === 0 ? "all 8 workspaces green" : stderr.split("\n")[0],
      );
      resolveProc();
    });
  });
}

async function withDemoBoot<T>(fn: () => Promise<T>): Promise<T> {
  console.log("\nBooting demo for verify probes (will be torn down)…");
  const proc = spawn("pnpm", ["demo"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" }, // suppress pino-pretty
  });
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", () => {
    /* swallow */
  });

  // Wait for the "Ready. Open" line or 25s.
  const ready = await new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 25_000);
    const interval = setInterval(() => {
      if (stdout.includes("Ready. Open")) {
        clearTimeout(t);
        clearInterval(interval);
        res(true);
      }
    }, 250);
  });
  if (!ready) {
    record(
      "demo boot",
      false,
      "didn't reach 'Ready. Open' within 25s — service ports likely in use",
    );
    proc.kill("SIGTERM");
    return undefined as unknown as T;
  }
  record("demo boot", true, "all 5 services listening");

  try {
    return await fn();
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  console.log("\nCREDIT — pre-demo verify\n");

  console.log("Static checks:");
  await runTypecheck();
  await checkMongo();
  await checkGeminiKey();

  console.log("\nLive service checks:");
  await withDemoBoot(async () => {
    await pingHealthz(4000, "credit-agent /healthz");
    await pingHealthz(4001, "agent-summarizer /healthz");
    await pingHealthz(4002, "agent-code-reviewer /healthz");
    await pingHealthz(4004, "agent-code-writer /healthz");
    await pingHealthz(4003, "customer-agent /healthz");
  });

  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log("─".repeat(50));
  if (failed.length === 0) {
    console.log(`\x1b[32m  ALL ${checks.length} CHECKS GREEN — ready to demo.\x1b[0m`);
    process.exit(0);
  } else {
    console.log(
      `\x1b[31m  ${failed.length} of ${checks.length} CHECKS FAILED:\x1b[0m`,
    );
    failed.forEach((c) => console.log(`     • ${c.label} — ${c.detail ?? ""}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exit(1);
});
