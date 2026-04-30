// Demo helper: hit the credit-agent's /debug/reset-demo to truncate
// per-task state and re-seed the canonical demo borrower presets.
// Built-in agents stay seeded (idempotent at server boot).
//
// Run with: pnpm reset-and-run
//
// Assumes credit-agent is already running (pnpm demo) on :4000.

import { request } from "undici";

const BASE = process.env.CREDIT_AGENT_URL ?? "http://localhost:4000";

async function main(): Promise<void> {
  console.log(`Hitting ${BASE}/debug/reset-demo …`);
  let res;
  try {
    res = await request(`${BASE}/debug/reset-demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error(
      `Could not reach credit-agent at ${BASE}. Is \`pnpm demo\` running?`,
    );
    console.error(err);
    process.exit(1);
  }

  const text = await res.body.text();
  if (res.statusCode === 404) {
    console.error(
      "Got 404. /debug routes are gated by DEBUG_ENDPOINTS_ENABLED=1.",
    );
    console.error(
      "Edit packages/credit-agent/.env or run via pnpm demo (which sets it).",
    );
    process.exit(1);
  }
  if (res.statusCode >= 400) {
    console.error(`reset-demo failed (${res.statusCode}):`, text);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("non-JSON response:", text.slice(0, 200));
    process.exit(1);
  }

  console.log("");
  console.log("✓ Demo reset.");
  if (parsed.cleared) {
    const cleared = Object.entries(parsed.cleared)
      .map(([k, v]) => `${k}=${v}`)
      .join(" · ");
    console.log(`  cleared: ${cleared}`);
  }
  if (parsed.borrowersReset) {
    console.log(`  borrowers re-seeded: ${parsed.borrowersReset.join(", ")}`);
  }
  console.log("");
  console.log("Three agents online. Click around http://localhost:3000");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
