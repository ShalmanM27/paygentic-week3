# Live-mode dress rehearsal checklist

Procedure for flipping CREDIT from offline-mock mode to live Locus beta.
Runs the marketplace happy path with real USDC on Base.

> Don't skip pre-flight. Live mode burns real beta USDC, so the cost of
> a missed step is a wasted dollar and a wasted demo slot.

---

## Pre-flight

### 1. Tests green

```bash
pnpm typecheck
pnpm test:all       # 8 acceptance tests, sequential, ~5 min total
```

If any test fails, **stop**. Fix it. Re-run. Live mode without green
tests is a guaranteed bad demo.

### 2. Wallet balances (cumulative as of 2026-04-30)

| Agent | Wallet | Min balance for demo |
|---|---|---|
| credit-agent | `0xb4474bcb6e1def001cfcd436de1c85046c4b1cbe` | **≥ $4.00 USDC** (lender pool + escrow buffer) |
| customer-agent | `0xac27014c0469a7d47ec7763e10197576c73f26a0` | ≥ $0.030 USDC (legacy `/flow` demo trigger) |
| agent-summarizer + agent-code-writer (shared `claw_dev_E6s` key) | `0x594a99c33716ec4b5cb3169759006834e1b1caa9` | n/a — the marketplace doesn't make these wallets pay; they receive |
| agent-code-reviewer (`claw_dev_98T` key) | `0x0b48460d4bbe08d219f5b3eed4e1935e275e1abf` | n/a — receive-only in marketplace flow |

Check balances at `https://beta.paywithlocus.com/dashboard` for each
account. If credit-agent dipped below $4, top up — escrow release
plus 18% APR loan flow consumes a few cents per cycle and you want
headroom.

### 3. Buyer wallet (you)

The marketplace flow has the **demo presenter** as the buyer. You'll
pay escrow from your personal Locus wallet, separate from the four
agent accounts.

1. Sign in to `https://beta.paywithlocus.com` with your demo email.
2. Top up at least **$0.05 USDC** on Base.
3. The Locus Checkout SDK will pick up your session automatically when
   you click "Pay" on the embedded widget.

### 4. Gemini API key set

```bash
grep GEMINI_API_KEY packages/borrower/.env || \
  echo "MISSING — set GEMINI_API_KEY in packages/borrower/.env"
```

Without it, live `do-work` will throw and the task will time out
mid-PROCESSING. (Offline mode uses the mock and doesn't need it.)

---

## Live mode flip

```bash
# 1. Switch credit-agent to live
sed -i '' 's/^LOCUS_OFFLINE_MODE=1$/LOCUS_OFFLINE_MODE=0/' \
  packages/credit-agent/.env

# 2. Switch customer-agent to live (only relevant if you'll demo /flow)
sed -i '' 's/^LOCUS_OFFLINE_MODE=1$/LOCUS_OFFLINE_MODE=0/' \
  packages/customer-agent/.env

# 3. Borrowers stay offline — the marketplace flow doesn't require them
#    to pay anything. They only need real Locus IF they borrow during
#    a task, which is a separate (optional) live test.

# 4. Restart the demo
pkill -f demo-runner   # if already running
pnpm demo
```

The credit-agent boot log should now read `locus mode: live/beta`.
The frontend will surface a green **LIVE MODE — real USDC on Base**
banner at the top of the home page.

---

## Live test path — marketplace happy path

1. Open `http://localhost:3000`.
2. Confirm the **LIVE MODE** banner is green (not gray).
3. Click **Use this agent →** on **Summarizer**.
4. Paste a paragraph (≥10 chars). Suggested prompt:
   > "Summarize the following: zero-knowledge proofs let one party prove
   > knowledge of a value without revealing it. They underpin privacy-
   > preserving rollups and identity systems."
5. Click **Pay $0.0080 & submit task**.
6. The Locus Checkout SDK widget mounts. Pay through your personal
   wallet.
7. The page redirects to `/tasks/T_NNNN`. Watch the timeline progress:
   - **Paid** — escrow tx hash appears (clickable BaseScan link)
   - **Dispatched** — credit-agent posted to summarizer's `/work-with-input`
   - **Processing** — summarizer is calling Gemini directly
   - **Delivered** — output renders below the timeline
   - **Released** — escrow tx out → agent wallet, second BaseScan link
8. Verify on BaseScan that:
   - Your wallet → credit-agent: $0.0080
   - credit-agent → agent wallet: $0.0080 (release tx)
9. The output should be **real Gemini-generated content** (no `[MOCK ...]`
   prefix).

Total time: ~30s end-to-end (Gemini cold-start dominates).

---

## Optional — borrow path live test

Only if you've topped up borrower wallets and want to demo the credit
line. Requires:
- Borrower wallet balance < `workCost` (drain via `/debug/seed-borrower`)
- Borrowers in live mode (`LOCUS_OFFLINE_MODE=0`)

In live mode, the agent borrows via `/credit/draw`+`/credit/fund`,
fulfills, and `collection-loop` repays within 10s. Real on-chain
disbursement and repayment, both visible on BaseScan.

---

## Post-test cleanup

```bash
# 1. Flip back to offline so subsequent dev/test runs don't burn USDC
sed -i '' 's/^LOCUS_OFFLINE_MODE=0$/LOCUS_OFFLINE_MODE=1/' \
  packages/credit-agent/.env
sed -i '' 's/^LOCUS_OFFLINE_MODE=0$/LOCUS_OFFLINE_MODE=1/' \
  packages/customer-agent/.env

# 2. Restart
pkill -f demo-runner
pnpm demo
```

---

## What to capture for the README

After the live run:

1. **Escrow-paid tx hash** — from the task detail page or session log
2. **Release tx hash** — agent receiving the released escrow
3. **Sample output** — the actual Gemini text the agent returned
4. **Total live USDC moved** — sum of escrow paid + (loan disbursement +
   loan repayment) if borrow path was tested
5. **Total time, end-to-end** — for the README's evidence table

Update `README.md`'s "Live evidence" table with real hashes (replace
the placeholder rows).

---

## Rollback if something goes wrong

If the live test fails partway through:

- Task stuck in DISPATCHED or PROCESSING beyond 90s → likely Gemini
  rate limit or network. Refresh the task page; the polling fallback
  (`5s` cadence) will catch the eventual state.
- Escrow paid but never released → check credit-agent logs for
  `escrow-watcher` ticks. Verify `getSession` polling is reaching
  Locus (curl the session id directly).
- Frontend stuck on LIVE banner but backend reports offline → confirm
  `/healthz` returns `{ ok: true, offline: false }`. Restart pnpm
  demo if .env edits weren't picked up.

If a partial-state task can't be recovered, run:
```bash
node -e 'fetch("http://localhost:4000/debug/reset-demo", { method: "POST" }).then(r => r.text()).then(console.log)'
```
to wipe DB state and start fresh. **Only do this in offline mode.**
