# CREDIT — Engineering reference (CLAUDE.md)

The canonical engineering doc. All architectural decisions, the Locus API
surface map, demo orchestration, and the hard constraints that frame the
project. New developers (or future me) read this to understand *why* the
codebase is the way it is — see [README.md](./README.md) for the
externally-facing pitch.

> Status: built for Locus Paygentic Week 3 (CheckoutWithLocus track).
> Hackathon window: 2026-04-29 → 2026-05-01. Hard $0 budget, no human
> triggers post-boot, MongoDB Atlas + Node.js + TypeScript, Locus must
> be the hero.

---

## Architectural decisions (chronological, latest first)

Each entry: date · what · why · trade-offs.

### 2026-05-01 — DB-backed agent registry with idempotent built-in seed (X4)

**What.** `agents` and `agent_subscriptions` Mongoose collections replace
the hardcoded `AGENTS` map. Built-ins (`summarizer`, `code-reviewer`,
`code-writer`) seeded by `seedBuiltInAgents()` at every server boot —
inserts only if missing, never duplicates. Operator-registered agents
start `isActive=false` and flip true when `subscription-watcher` sees
the rent session settle PAID.

**Why.** The marketplace thesis is "anyone can host an agent." That
required (a) a registration surface, (b) a rent flow proving operators
must commit USDC to host (Checkout flow #6), (c) public registry data
that scales beyond three agents.

**Trade-offs.**
- The `walletAddress` field on built-in `Agent` rows is decorative — the
  real wallet lives on `borrowers.walletAddress`. Built-in surfaces
  consult `getAdminAgent` for the live wallet, not the registry row.
- `subscription.escrowSessionId` is unique. If a registration request
  fails between session-create and DB-write, the orphaned session is
  unrecoverable. Demo-acceptable.
- Rent renewal is not implemented — coverage ends after 30 days but
  nothing flips agents back to inactive. Documented as a noted gap.

### 2026-05-01 — Hackathon-grade output verification (X2)

**What.** `verifyTaskOutput()` checks: ≥20 chars, ≤50000 chars, no
refusal-pattern prefix (`I cannot`, `I can't`, `As an AI`, etc., 8
patterns total). Pass → release escrow to agent. Fail → `FAILED →
REFUNDED`.

**Why.** We need *some* gate between agent output and escrow release to
make the verification step a real architectural feature, not just
ceremony. Production would be LLM-as-judge or human-in-loop; this is
the explicit placeholder.

**Trade-offs.** Refusal-prefix matching has false negatives (an agent
that "refuses politely in the middle of the response" passes) and false
positives (a legitimate output starting with "I don't think…" fails).
Acceptable for the demo; the test suite covers both branches.

### 2026-04-30 — getSession polling for beta confirmation

**Source.** Locus team via LocusBot QA.

**Findings.**
- **Webhooks are NOT implemented in Locus beta.** The CHECKOUT.md docs
  describe intended future behavior; `webhookUrl` on `createSession` is
  silently ignored, no `whsec_` is ever returned at session-create time.
- `GET /checkout/agent/payments/:id` has a known beta bug (overly strict
  permission check) — confirmed by the Locus team. Our feedback id
  `95a8f43f-…` is on record.
- **`GET /checkout/sessions/:id` IS the correct confirmation path in
  beta.** Status transitions `PENDING → PAID` (with `paymentTxHash`) or
  `PENDING → EXPIRED`.

**Implementation.**
- `LocusClient.waitForSessionSettled(sessionId, timeoutMs)` polls
  `getSession` every 2s ± jitter until terminal status.
- `fund.ts` uses it after `agentPay` on the target session — captures
  `paymentTxHash` directly into `loan.disbursementTxHash`. On timeout:
  persists as `FUNDED` with `disbursementStatus="UNKNOWN"` (does NOT
  502 — money likely moved, just unconfirmable).
- `collection-loop.ts` uses it after `agentPay` on the repayment
  session. On timeout: schedules retry; the next tick re-checks
  (idempotent: `waitForSessionSettled` returns immediately if the
  session is already PAID).
- `escrow-watcher` and `subscription-watcher` poll `getSession` on a 3s
  cadence for tasks/subscriptions in pending states.

**Trade-offs.**
- **Pros**: real `txHash` from beta, no tunnel/cloudflared needed, no
  dashboard config required, single confirmation mechanism for both
  disbursement and repayment.
- **Cons**: each disbursement and repayment blocks for up to 30s
  waiting for settlement. Acceptable for hackathon scale (handful of
  loans per demo). For production scale this would move to webhooks
  once Locus ships them.

### 2026-04-30 — LLM via Google AI Studio direct, not Locus wrapped

**Reason.** Locus's wrapped Gemini API charges ~$0.094 USDC per call
(verified live; 403 "Insufficient USDC balance" on the smoke). With 3
agents × 4–8 calls per demo run, that exceeds our hackathon USDC
budget. We use Google AI Studio's direct free tier instead (15 req/min,
1500/day, $0).

**Trade-off.** LLM calls no longer flow through Locus. **However, every
BYTE OF VALUE in the system still does:**
- User pays escrow → Locus Checkout
- Credit funds agents → Locus agent-pay
- Agents repay loans → Locus agent-pay
- Score-as-a-service → Locus Checkout
- Add Agent rent → Locus Checkout (X4)

The LLM is the *work* the agent performs; its API billing is a
production substrate concern, not a load-bearing demo element. In
production, an agent operator could swap the wrapped API back in with a
single env-flag change in `do-work.ts` (one HTTP call site, contained).

### 2026-04-30 — Webhook handler kept; not on critical path

**Diagnosis.** Polling endpoints `/checkout/agent/payments/:id`,
`/checkout/agent/payments` (list), and `/pay/transactions/:id` all
return 403 or empty for both buyer and merchant on transactions we
genuinely initiated and that settled on-chain (BaseScan-confirmed).
Locus's own messaging says "poll OR wait for webhook"; we can't
reliably do either, so we built both.

**Implication.** `waitForConfirm()` is *deprecated for beta* but kept
on the client for production. Disbursement and repayment flows trust
`agentPay`'s 200 response and persist immediately. Confirmation arrives
async via `getSession` polling. Webhook handler kept as defense-in-depth
for the day Locus ships webhook delivery.

### 2026-04-29 — Multi-tenant via shared wallets

**What.** 4 Locus beta accounts, 3 active agents. Operator A
(`claw_dev_E6s` key, wallet `0x5944…caa9`) hosts both Summarizer and
Code Writer. Operator B (`claw_dev_98T` key, wallet `0x0b48…1abf`) hosts
Code Reviewer alone.

**Why.** Proves the open-marketplace thesis: anyone can host on the
platform, and one operator can list multiple services. Required dropping
the unique constraint on `borrowers.walletAddress` (handled in
`borrower.model.ts`; demo-runner calls `BorrowerModel.syncIndexes()` on
boot to drop the lingering DB-side index).

### 2026-04-29 — Mock Gemini in offline mode

**What.** `do-work.ts` returns a deterministic `[MOCK ${agentId}] …`
string in offline mode (1s sleep so the lifecycle visibly progresses).
`MOCK_REFUSE=1` env flag emits a refusal-prefixed string for
verification-failure tests.

**Why.** Tests never burn Gemini quota. Local dev never costs real LLM
calls. Mock mode is the default for `pnpm demo`.

---

## Locus API surface map (canonical reference)

These are the only Locus endpoints we call. Each row reflects empirical
testing against beta as of 2026-04-30.

### Endpoint table

| Purpose | Method + Path | Body casing | Status enum | Notes |
|---|---|---|---|---|
| Read wallet balance | `GET /api/pay/balance` | snake | n/a | `usdc_balance` + `promo_credit_balance` (separate budget pools) |
| Send raw USDC | `POST /api/pay/send` | snake | UPPERCASE (`QUEUED`) | `amount` is **NUMBER** not string (isolated to this endpoint) |
| Create checkout session | `POST /api/checkout/sessions` | camel | UPPERCASE | `webhookSecret` NOT returned (likely account-level); URL field is `checkoutUrl`, not `payUrl` |
| Get session details | `GET /api/checkout/sessions/:sessionId` | camel | UPPERCASE | Same shape as create + `createdAt`, `metadata`, `paymentTxHash` (on PAID); omits `checkoutUrl` |
| Preflight | `GET /api/checkout/agent/preflight/:sessionId` | camel (FLAT envelope) | UPPERCASE | `{ canPay, agent: {…}, session: {…}, blockers? }`. `session.sellerWalletAddress` (NOT `merchantAddress`); `availableBalance: "999999"` is a sentinel for no-allowance, not real balance |
| Pay session as agent | `POST /api/checkout/agent/pay/:sessionId` | camel | **lowercase** (`queued`/`processing`/`confirmed`/`failed`/`policy_rejected`) | Differs from `/pay/send` despite both initiating payment. Casing is per-endpoint with no global pattern |
| Poll payment | `GET /api/checkout/agent/payments/:transactionId` | 403 in beta — unusable | — | Known beta bug. Scoped to the agent that called `agentPay` (cross-agent polling impossible). Use `getSession` instead |
| Poll raw tx | `GET /api/pay/transactions/:id` | 403 in beta — unusable | — | Same scope issue |
| Webhook delivery | configured in dashboard | n/a | n/a | **Not implemented in beta.** Documented in CHECKOUT.md but doesn't fire |

### Auth

`Authorization: Bearer claw_…`. Each agent has its own Locus account
→ its own `claw_` key → its own wallet. Cross-agent polling is
impossible (the same key that called `agentPay` must call `getPayment`
or `getSession` for confirmation).

### Envelope shapes

Locus uses **two** envelope shapes across the platform:
- Wrapped `{ success, data }` for `/pay/balance`, `/checkout/sessions`
- Flat `{ success, …fields }` for `/checkout/agent/preflight`

Our `LocusClient` handles both.

### Wallet registry (seeded 2026-04-29)

| Agent | Key | Wallet | Final balance |
|---|---|---|---|
| credit-agent | `claw_dev_E6s_credit` | `0xb4474bcb…1cbe` | $4.87 USDC |
| summarizer + code-writer (shared) | `claw_dev_E6s` (Operator A) | `0x594a99c3…caa9` | $0.05 USDC |
| code-reviewer | `claw_dev_98T` (Operator B) | `0x0b48460d…1abf` | $0.03 USDC |
| customer | `claw_dev_customer` | `0xac27014c…26a0` | $0.05 USDC |

Diagnostic + seeding spend during dev: ~$0.020 USDC.

---

## How the demo works

### Modes

`pnpm demo` boots all five services in **one Node process** (offline
mode, mocked Locus). This is the canonical entry point — `pnpm dev:all`
exists but spawns isolated processes that don't share the in-memory
mock session registry, so cross-agent `agentPay` calls fail.

### Service ports

| Service | Port |
|---|---|
| credit-agent | 4000 |
| agent-summarizer | 4001 |
| agent-code-reviewer | 4002 |
| customer-agent | 4003 |
| agent-code-writer | 4004 |
| frontend | 3000 |

### Cron loop cadences

| Loop | Interval | Trigger |
|---|---|---|
| `collection-loop` | 10s (3s in demo) | Repayment queue items in WAITING |
| `score-recompute-loop` | 30s (5s in demo) | All ACTIVE borrowers |
| `default-loop` | 60s (5s in demo) | FUNDED loans past `dueAt + grace` |
| `escrow-watcher` | 3s | Tasks in DRAFT or PAID |
| `subscription-watcher` | 3s | Subscriptions in PENDING_PAYMENT |
| `settlement-watcher` | 30s (off by default) | Defense-in-depth balance check |
| heartbeat (SSE) | 15s | Frontend connection health |

### Frontend pages

| Path | Purpose |
|---|---|
| `/` | Marketplace home — agent grid, hero, how-it-works, live activity feed |
| `/agent/[id]` | Per-agent storefront — capabilities, pricing, try-it form |
| `/tasks` | Tasks dashboard — filter chips + table + pagination |
| `/tasks/[taskId]` | Task detail — checkout SDK + lifecycle timeline + output + Locus refs |
| `/add-agent` | Operator registration form |
| `/add-agent/[subscriptionId]` | Rent payment + activation timeline |
| `/about` | Static — what / how / built-on |
| `/flow` | Backup demo — five-card lend/repay sequence (legacy) |
| `/transactions` | Flat ledger with filters and BaseScan links |
| `/admin/agents/[id]` | Operator detail — credit profile, loans, score-events |

### Built-in vs operator-registered agents (X4)

- The 3 built-in agents are seeded into the `agents` collection at
  `buildServer()` boot via `seedBuiltInAgents()`. Idempotent — re-runs
  do nothing. `isBuiltIn=true`, `isActive=true` permanently. They never
  owe rent and can't expire.
- Operator-registered agents start with `isActive=false`. The
  `subscription-watcher` flips them active when the rent session
  settles PAID. The `/agents/registry` endpoint returns `isActive=true`
  only — inactive agents are invisible to buyers.
- `/agent/[id]` shows an "Awaiting deployment" banner whenever
  `!agent.isBuiltIn`, and disables the submit button to protect buyers
  from wasted escrow on placeholder serviceUrls.

### Helpful scripts

```bash
pnpm verify             # pre-demo health check
pnpm demo               # boot 5-service single-process offline demo
pnpm dev:web            # frontend on :3000
pnpm reset-and-run      # truncate per-task DB state, re-seed borrowers
pnpm test:all           # 8 acceptance tests, sequential, ~5 min
```

### Smoke-test budget

Total live USDC spent on diagnostic smokes: **$0.020** (4 × $0.005).
`smoke-pay.ts` archived 2026-04-30; no further live spend until dress
rehearsal.

---

## Hard constraints

- **$0 budget.** Free tiers only. No paid LLMs anywhere.
- **No human triggers.** Every action is autonomous after boot.
- **MongoDB** for persistence.
- **Node.js + TypeScript** across all services.
- **Locus Checkout must be the hero** — every money movement is a Locus
  session.
- **Use beta environment only:** `https://beta-api.paywithlocus.com/api`.

---

## MongoDB collections (8)

| Collection | Purpose |
|---|---|
| `borrowers` | Agent identity, wallet, score, limit, outstanding, status |
| `loans` | One row per loan (REQUESTED → FUNDED → REPAID/DEFAULTED), `linkedTaskId` ties to escrow tasks |
| `score_events` | Append-only history feeding the score recompute loop |
| `transactions` | Flat ledger of every USDC movement (`draw`, `repayment`, `score_sale`, etc.) |
| `repayment_queue` | Per-loan, with state machine WAITING → ATTEMPTING → COMPLETED/FAILED |
| `score_reports` | Created on `POST /score-report`, unlocked on `checkout.session.paid` |
| `tasks` (X2) | Escrow-flow records, status DRAFT → PAID → DISPATCHED → PROCESSING → DELIVERED → RELEASED/FAILED/REFUNDED/EXPIRED |
| `agents` (X4) | DB-backed marketplace registry, `isBuiltIn` and `isActive` flags |
| `agent_subscriptions` (X4) | Rent payment records, status PENDING_PAYMENT → ACTIVE/EXPIRED |
| `counters` | Atomic monotonic counters for `taskId` (`T_NNNN`) and `subscriptionId` (`S_NNNN`) |

---

## Score function

Score in [300, 850]. Cold-start = 500. Recomputed every 30s from
`score_events`.

```
score = 500
       + 30 * delivery_success_rate     // [0..1]
       - 25 * refund_rate               // [0..1]
       + 50 * repayment_punctuality     // [0..1]
       - 80 * default_count
       + 10 * log(1 + lifetime_repaid)
       - 5  * open_loan_count
```

Clamp to [300, 850].

---

## Policy function

```ts
function rateFor(score: number): number {
  if (score >= 800) return 0.05;
  if (score >= 700) return 0.08;
  if (score >= 600) return 0.12;
  if (score >= 500) return 0.18;
  return 0.99;  // not lendable
}

function repayAmount(principal: number, rate: number, ttlSeconds: number): number {
  const accrued = principal * rate * (ttlSeconds / (365 * 24 * 3600));
  return Math.max(principal + 0.0001, principal + accrued);
}
```

`limit = max(0, min((score - 500) * 0.5, MAX_LOAN_USDC * 4))`. The cap
keeps the displayed limit meaningful relative to the actual max-loan
size.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Web framework | Fastify |
| Database | MongoDB Atlas Free Tier (M0, 512 MB) |
| ODM | Mongoose |
| Job scheduling | `setInterval` + atomic Mongo claim |
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| Live updates | Server-Sent Events |
| HTTP client | undici (built-in) |
| Webhook signature | node:crypto HMAC-SHA256 |
| Logging | pino |
| LLM | Gemini 1.5 Flash (Google AI Studio direct, free tier) |

No paid LLMs. All "decisions" are deterministic numeric rules.

---

## Repayment queue state machine

```
WAITING  ──┐ atomic claim
           ▼
        ATTEMPTING  ──┐ insufficient balance / preflight fail / max attempts
           │           ▼
           │        WAITING (retry w/ backoff) or FAILED → defaultLoan()
           ▼
   ATTEMPTING_SETTLED ──┐ webhook (deferred) OR settlement-watcher observes drop
           │             ▼
           ▼          COMPLETED
```

`preAmountSnapshot` is captured on the queue row just before `agentPay`
so the watcher can verify.

---

## API contracts (summary)

Full docs in source. Key shapes:

```http
POST /credit/draw
{ "borrowerId", "amount", "purpose", "ttl", "taskId"? }
200 → { "approved": true, "decisionToken", "amount", "rate", "repayAmount", "expiresAt", "dueAt" }
403 → { "approved": false, "reason": "insufficient_credit_limit" | "score_too_low" | ... }
```

```http
POST /credit/fund
{ "decisionToken", "targetSessionId" }
200 → { "loanId", "disbursement": { "transactionId", "txHash", "status" }, "repaymentSessionId", "repayAmount", "dueAt" }
```

```http
POST /tasks
{ "agentId", "input", "userIdentifier"? }
200 → { "task", "checkoutUrl", "sessionId" }
```

```http
POST /agents/register
{ "agentId", "displayName", "description", "category", "emoji", "pricingUsdc",
  "operatorName", "operatorEmail", "serviceUrl", "walletAddress", "capabilities" }
200 → { "agent", "subscription", "checkoutUrl", "sessionId" }
```

```http
GET /healthz
200 → { "ok": true, "offline": boolean, "locusMode": "offline/mock" | "live/beta" }
```

```http
GET /events     // SSE stream
data: { "kind": "task.released", "taskId": "T_0001", "agentId": "summarizer", "releaseTxHash": "..." }
data: { "kind": "agent.activated", "agentId": "image-creator", "subscriptionId": "S_0001", "coverageEndAt": "..." }
data: { "kind": "score.changed", "borrowerId": "summarizer", "from": 500, "to": 580 }
```

---

## SSE event surface (all kinds)

Loans / scores / sessions (pre-X2):
- `loan.funded`, `loan.repaid`, `loan.defaulted`
- `score.changed`, `score.sold`
- `session.paid`, `session.expired`
- `system.heartbeat`

Escrow-task lifecycle (X2):
- `task.created`, `task.escrow_paid`, `task.dispatched`, `task.processing`,
  `task.borrowing`, `task.borrowed`, `task.delivered`, `task.released`,
  `task.failed`, `task.refunded`, `task.expired`

Agent registration / rent (X4):
- `agent.registered`, `agent.activated`, `subscription.expired`

---

## Notes for future me

- The `/agent/[id]` "Awaiting deployment" trigger is currently `!isBuiltIn`.
  Replace with `agent.deployedAt != null` once we add a real reachability
  probe / deployment record.
- The hardcoded `0xbuiltin_*` wallets in `BUILTIN_AGENTS` are decorative.
  When borrowers re-register through `/credit/register`, the live wallet
  is set on the borrower row, not the agent row. Don't read from
  `agent.walletAddress` for built-ins — call `getAdminAgent` instead.
- `seedBuiltInAgents()` runs in `buildServer()`. Tests that delete the
  `agents` collection before booting will get re-seeded on the same
  call; tests that don't will keep stale rows. The `test-add-agent`
  harness explicitly clears `AgentModel` and `AgentSubscriptionModel`
  in setup.
- The `MOCK_REFUSE=1` env flag is a test-only hook. Don't ship it in
  production builds.
- `markMockSessionExpired()` is the test-only counterpart to
  `markMockSessionPaid()`. Both live in `mock-client.ts` exports.
