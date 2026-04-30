# CREDIT — Agent-to-Agent Lending on Locus

A paid agent-scoring service that also lends USDC, with every dollar in and out flowing through Locus Checkout. Built for the Locus Paygentic Week 3 hackathon (CheckoutWithLocus track).

---

## What We're Building

CREDIT is the credit layer for the agent economy. Autonomous agents that run out of USDC mid-task can request a loan, get funded by Credit Agent, complete their work, and have repayment auto-collected from earnings — all via Locus Checkout sessions, with no human in the loop.

Three Locus Checkout flows are load-bearing:
1. **Disbursement** — Credit pays a session on behalf of a borrower
2. **Repayment** — Credit creates a session in borrower's name, auto-collects when balance recovers
3. **Score-as-a-service** — third-party agents pay $0.01 to read full credit reports

The system is designed around the core thesis: agents change behavior based on money. Borrowers refuse jobs that won't clear cost basis. Credit refuses borrowers who don't clear score thresholds. Every decision is economic.

---

## Hard Constraints

- **$0 budget.** Free tiers only. No paid LLMs anywhere.
- **No human triggers.** Every action is autonomous after boot.
- **MongoDB** for persistence (already chosen).
- **Node.js + TypeScript** across all services.
- **Locus Checkout must be the hero** — every money movement is a Locus session.
- **Use beta environment only:** `https://beta-api.paywithlocus.com/api`.

---

## Verified Locus API Surface

These are the only Locus endpoints we'll call. Confirmed from official skill files.

| Purpose | Method + Path |
|---|---|
| Read wallet balance | `GET /api/pay/balance` |
| Send raw USDC | `POST /api/pay/send` |
| Create checkout session (merchant) | `POST /api/checkout/sessions` |
| Get session details | `GET /api/checkout/sessions/:sessionId` |
| Preflight a session | `GET /api/checkout/agent/preflight/:sessionId` |
| Pay a session as agent | `POST /api/checkout/agent/pay/:sessionId` |
| Poll payment status | `GET /api/checkout/agent/payments/:transactionId` |
| Receive webhooks | configured in dashboard → `checkout.session.paid`, `checkout.session.expired` |

Auth: `Authorization: Bearer claw_...`. Each agent has its own Locus account → its own `claw_` key → its own wallet.

---

## Wire format observations (confirmed live)

- **2026-04-29**: `GET /api/pay/balance` returns **SNAKE_CASE**.
  Fields: `wallet_address`, `workspace_id`, `chain`, `usdc_balance`, `promo_credit_balance`, `allowance`, `max_transaction_size`.
- **2026-04-29**: `POST /api/checkout/sessions` returns **CAMELCASE**.
  Fields: `id`, `checkoutUrl`, `amount`, `currency`, `status`, `expiresAt`.
  Notes: `webhookSecret` **NOT returned** (likely account-level, not per-session). `payUrl` does not exist — the URL field is named `checkoutUrl`.
- **2026-04-29**: `GET /api/checkout/sessions/:id` returns **CAMELCASE**.
  Same shape as createSession but adds `createdAt` + `metadata`, omits `checkoutUrl`. Metadata round-trips intact (usable for our `loanId` carrier).
- **2026-04-29**: `GET /api/checkout/agent/preflight/:id` returns **FLAT envelope**.
  Shape: `{ success, canPay, agent: { walletAddress, availableBalance }, session: { id, amount, currency, description, status, expiresAt, sellerWalletAddress }, blockers? }`.
  Note: `preflight.session` is **NOT** the same shape as `CheckoutSession`. Different field names (`sellerWalletAddress` vs `merchantAddress`). `availableBalance: "999999"` appears to be a sentinel for "no allowance configured", not a real balance.
- **DISCOVERY**: Locus uses two envelope shapes across the platform.
  Wrapped `{ success, data }` for some endpoints (`/pay/balance`, `/checkout/sessions`), flat `{ success, ...fields }` for others (`/checkout/agent/preflight`). Our client now handles both.
- **2026-04-29**: `balance()` returns **two independent budgets**: `usdc_balance` (real on-chain USDC, used for sends and session payments) and `promo_credit_balance` (platform credit; hypothesis: covers wrapped API call fees, **NOT** outbound USDC transfers — verify on first wrapped API call). Treat as separate budget pools.
- **2026-04-30**: `POST /api/checkout/agent/pay/:sessionId` returns **CAMELCASE** with **LOWERCASE** `status`. Fields: `transactionId`, `queueJobId`, `status` (`"queued"|"processing"|"confirmed"|"failed"|"policy_rejected"`), `sessionId`, `amount` (string), `currency`, `statusEndpoint`, `message?`. **Differs from `/pay/send`** (which is snake_case + UPPERCASE) despite both being payment-initiating. Locus casing is per-endpoint; no global pattern. First live agent-pay session: `cdc7fad2-63f6-4dfe-9f06-eac9d8661254`.
- **2026-04-30 (PENDING)**: `GET /api/checkout/agent/payments/:transactionId` shape — pending next smoke run after type fixes.
- **2026-04-30**: `GET /api/checkout/agent/payments/:transactionId` is **SCOPED** to the agent that called `agentPay`. Calling `getPayment` with a different agent's `claw_` key returns **403** `"Transaction does not belong to this agent"`. **Implication:** the SAME client (i.e. SAME `claw_` key) MUST be used for `agentPay → waitForConfirm → getPayment`. Cross-agent polling is impossible. **The webhook is the only way for OTHER parties (e.g. the merchant) to learn about the payment outcome** — which is exactly the architecture we have. Collection-loop in offline mode calls `handleRepaymentPaid` directly to simulate the live webhook path; both converge cleanly.

### Locus casing summary (cumulative)

| Endpoint                              | Casing  | Status enum             |
| ------------------------------------- | ------- | ----------------------- |
| GET  /pay/balance                     | snake   | n/a                     |
| POST /pay/send                        | snake   | UPPERCASE               |
| POST /checkout/sessions               | camel   | UPPERCASE               |
| GET  /checkout/sessions/:id           | camel   | UPPERCASE               |
| GET  /checkout/agent/preflight/:id    | camel   | UPPERCASE               |
| POST /checkout/agent/pay/:id          | camel   | lowercase               |
| GET  /checkout/agent/payments/:id     | 403 in beta — unusable  |                         |
| GET  /pay/transactions/:id            | 403 in beta — unusable  |                         |

---

## Architectural decision: webhook-driven confirmation

**Date: 2026-04-30**

### Diagnosis

- Polling endpoints `/checkout/agent/payments/:id`, `/checkout/agent/payments` (list), and `/pay/transactions/:id` all return **403** or empty for both buyer and merchant on transactions we genuinely initiated and that settled on-chain (BaseScan-confirmed).
- Three live agentPay payments confirmed on-chain (customer-agent → credit-agent, $0.005 each):
  - tx 1: session `cdc7fad2-…`
  - tx 2: session `9602f71d-…`
  - tx 3: session `51573df7-…`
- Locus's own messaging says "poll OR wait for webhook"; we choose webhook.

### Implication

- `waitForConfirm()` is **deprecated for beta** but kept on the client for production where the polling endpoint may behave correctly. Diagnostic is beta-only.
- Disbursement and repayment flows trust `agentPay`'s 200 response and **persist immediately**. Confirmation arrives async via:
  - **Primary:** `checkout.session.paid` webhook
  - **Fallback:** balance-verification (`settlement-watcher`, every 30s, watches borrower wallet for the expected balance drop)
- `txHash` is unknown at agentPay time. It arrives in the webhook payload; remains `null` if confirmation comes via the watcher fallback. **Frontend treats null `txHash` as "settling"**.

### Repayment queue state machine (post-pivot)

```
WAITING  ──┐ atomic claim
           ▼
        ATTEMPTING  ──┐ insufficient balance / preflight fail / max attempts
           │           ▼
           │        WAITING (retry w/ backoff) or FAILED → defaultLoan()
           ▼
   ATTEMPTING_SETTLED ──┐ webhook (primary) OR settlement-watcher observes drop
           │             ▼
           ▼          COMPLETED
```

`preAmountSnapshot` is captured on the queue row just before `agentPay` so the watcher can verify.

## Architectural decision: getSession polling for beta confirmation

**Date: 2026-04-30**
**Source: Locus team via LocusBot QA**

### Findings

- **Webhooks are NOT implemented in Locus beta.** The CHECKOUT.md docs describe intended future behavior; `webhookUrl` on `createSession` is silently ignored, no `whsec_` is ever returned at session-create time.
- `GET /checkout/agent/payments/:id` has a known beta bug (overly strict permission check) — confirmed by the Locus team. Our feedback id `95a8f43f-…` is on record.
- **`GET /checkout/sessions/:id` IS the correct confirmation path in beta.** Status transitions `PENDING → PAID` (with `paymentTxHash`) or `PENDING → EXPIRED`.

### Implementation

- Added `LocusClient.waitForSessionSettled(sessionId, timeoutMs)` that polls `getSession` every 2s ± jitter until terminal status.
- `fund.ts` uses it after `agentPay` on the target session — captures `paymentTxHash` directly into `loan.disbursementTxHash` and sets `disbursementStatus="CONFIRMED"`. On timeout: persists as `FUNDED` with `disbursementStatus="UNKNOWN"` (does NOT 502 — money likely moved, just unconfirmable).
- `collection-loop.ts` uses it after `agentPay` on the repayment session — calls `handleRepaymentPaid(loanId, paymentTxHash, log)` with the real txHash. On timeout: schedules retry; the next tick re-checks (idempotent: `waitForSessionSettled` returns immediately if the session already PAID).
- Settlement-watcher disabled by default (`SETTLEMENT_WATCHER_ENABLED=0`). Kept as defense-in-depth.
- Webhook handler kept and tested but no longer on the critical path. Banner at top of `webhooks.ts` documents the strategic state.

### Trade-offs

- **Pros**: real `txHash` from beta, no tunnel/cloudflared needed, no dashboard config required, tests already cover this path, single confirmation mechanism for both disbursement and repayment.
- **Cons**: each disbursement and repayment now blocks for up to 30s waiting for settlement. Acceptable for hackathon scale (handful of loans during demo). For production scale this would move to webhooks once Locus ships them.

---

### Smoke-test budget consumed

- Total live USDC spent on diagnostic smokes: **$0.020** (4 × $0.005)
- Customer-agent balance after diagnostics: **~$0.030**
- Credit-agent balance after diagnostics: **~$4.890**
- **Decision:** `smoke-pay.ts` archived. No further live spend until Phase B (real webhook validation) and dress rehearsal.
- **2026-04-29**: `POST /pay/send` returns **SNAKE_CASE**. Fields: `transaction_id`, `queue_job_id`, `status` (string enum, observed `"QUEUED"`), `from_address`, `to_address`, `amount` (**NUMBER** not string — breaks Money convention; isolated to this endpoint), `token` `"USDC"`. Three real transfers confirmed on BaseScan. txids: `9e921487…` (→borrower-a $0.05), `74b5da34…` (→borrower-b $0.03), `d788fbd6…` (→customer $0.05).
- **PENDING (Phase B live smoke 2026-04-30)**: webhook delivery shape — exact header name (`x-locus-signature` assumed), HMAC scheme, body shape, and whether `txHash` arrives in the webhook payload. To be filled in after the live cloudflared webhook run.

---

## Wallet registry (seeded)

Seeded on **2026-04-29**.

| Agent | Wallet address | Final balance | Seeding tx |
|---|---|---|---|
| credit-agent | `0xb4474bcb6e1def001cfcd436de1c85046c4b1cbe` | 4.87 USDC | (sender) |
| borrower-a | `0x594a99c33716ec4b5cb3169759006834e1b1caa9` | 0.05 USDC | `9e921487-855b-40ab-b8d5-7be2591024b5` |
| borrower-b | `0x0b48460d4bbe08d219f5b3eed4e1935e275e1abf` | 0.03 USDC | `74b5da34-723f-4b47-b309-b410cbf916b0` |
| customer | `0xac27014c0469a7d47ec7763e10197576c73f26a0` | 0.05 USDC | `d788fbd6-9441-4554-b74b-43232a39fb95` |

These addresses are canonical. Future scripts and runtime code should treat this table as the source of truth — do not re-derive from `.env`.

---
## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Web framework | Fastify |
| Database | MongoDB Atlas Free Tier (M0, 512 MB) |
| ODM | Mongoose |
| Job scheduling | node-cron + in-process queue |
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| Live updates | Server-Sent Events |
| HTTP client | undici (built-in) |
| Webhook signature | node:crypto HMAC-SHA256 |
| Logging | pino |
| Hosting | Vercel (frontend) + Render free tier (backends) |

No LLMs. All "decisions" are deterministic numeric rules.

---

## Architecture

```
                           ┌──────────────────────────────────────┐
                           │         Locus Beta (external)         │
                           │  beta-api.paywithlocus.com/api       │
                           │  - wallets, balance, /pay/send       │
                           │  - /checkout/sessions (create)       │
                           │  - /checkout/agent/preflight, /pay   │
                           │  - webhook fan-out: session.paid/etc │
                           └─────────▲──────────────▲─────────────┘
                                     │ HTTP         │ Webhook POST
                                     │              │ (HMAC signed)
   ┌─────────────────────────────────┼──────────────┼────────────────────────────┐
   │                          Our system (Node + Mongo)                          │
   │                                                                             │
   │  ┌────────────────┐    ┌────────────────┐    ┌────────────────┐             │
   │  │ Borrower A     │    │ Borrower B     │    │ Customer Agent │             │
   │  │ (good citizen) │    │ (deadbeat)     │    │ (driver)       │             │
   │  │ port 4001      │    │ port 4002      │    │ port 4003      │             │
   │  └──────┬─────────┘    └──────┬─────────┘    └───────┬────────┘             │
   │         │                     │                      │                       │
   │         │  HTTP: /credit/*    │                      │ POSTs jobs to A & B   │
   │         ▼                     ▼                      │                       │
   │  ┌──────────────────────────────────────────────┐    │                       │
   │  │           Credit Agent (port 4000)           │◄───┘                       │
   │  │ Endpoints: register/draw/fund/score/         │                            │
   │  │           score-report/webhooks-locus        │                            │
   │  │ Background loops:                            │                            │
   │  │   - collection-loop (every 10s)              │                            │
   │  │   - score-recompute-loop (every 30s)         │                            │
   │  │   - default-loop (every 60s)                 │                            │
   │  │ SSE: /events  (frontend subscribes)          │                            │
   │  └──────┬─────────────────────────┬─────────────┘                            │
   │         │                         │                                          │
   │         ▼                         ▼                                          │
   │  ┌────────────┐         ┌──────────────────┐                                 │
   │  │  MongoDB   │         │   Frontend       │                                 │
   │  │  Atlas M0  │         │   Next.js        │                                 │
   │  │  5 colls   │         │   (Vercel)       │                                 │
   │  └────────────┘         └──────────────────┘                                 │
   └─────────────────────────────────────────────────────────────────────────────┘
```

**Discovery:** at boot, Borrower A and Borrower B fetch `GET <credit>/.well-known/locus-credit.json`. They cache it. When they need money, they hit Credit endpoints directly.

**Money flow:** all USDC moves through Locus. Our backend never holds funds; it orchestrates Locus API calls.

---

## Folder Structure

```
paygentic-week3/
├── package.json                     # workspaces
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
├── README.md
├── CLAUDE.md                        # this file
│
├── packages/
│   ├── shared/                      # types, locus client, mongo schemas
│   │   ├── src/
│   │   │   ├── locus/
│   │   │   │   ├── client.ts        # thin wrapper over Locus API
│   │   │   │   ├── types.ts
│   │   │   │   └── webhook.ts       # HMAC verify
│   │   │   ├── db/
│   │   │   │   ├── connection.ts
│   │   │   │   ├── borrower.model.ts
│   │   │   │   ├── loan.model.ts
│   │   │   │   ├── score-event.model.ts
│   │   │   │   ├── transaction.model.ts
│   │   │   │   └── repayment-queue.model.ts
│   │   │   ├── score/
│   │   │   │   └── score.ts         # deterministic score function
│   │   │   ├── policy/
│   │   │   │   └── policy.ts        # decide(amount, score) → rate
│   │   │   ├── sse/
│   │   │   │   └── bus.ts           # global event emitter
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── credit-agent/
│   │   ├── src/
│   │   │   ├── server.ts            # Fastify app
│   │   │   ├── routes/
│   │   │   │   ├── register.ts
│   │   │   │   ├── draw.ts
│   │   │   │   ├── fund.ts
│   │   │   │   ├── score.ts
│   │   │   │   ├── score-report.ts
│   │   │   │   ├── webhooks.ts
│   │   │   │   ├── well-known.ts
│   │   │   │   └── events.ts        # SSE
│   │   │   ├── jobs/
│   │   │   │   ├── collection-loop.ts
│   │   │   │   ├── score-recompute-loop.ts
│   │   │   │   └── default-loop.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── borrower-a/
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── work.ts          # the paid endpoint
│   │   │   │   └── webhooks.ts
│   │   │   ├── lib/
│   │   │   │   ├── decide-borrow.ts
│   │   │   │   └── do-work.ts       # mocked Firecrawl
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── borrower-b/                  # same code as borrower-a, different env
│   │   └── package.json
│   │
│   └── customer-agent/
│       ├── src/
│       │   ├── server.ts            # exposes /trigger for demo control
│       │   ├── lib/
│       │   │   └── send-job.ts
│       │   └── index.ts
│       └── package.json
│
└── apps/
    └── frontend/                    # Next.js
        ├── app/
        │   ├── page.tsx             # Dashboard
        │   ├── agents/[id]/page.tsx
        │   ├── score/[wallet]/page.tsx
        │   ├── flow/page.tsx        # Loan Flow demo viz
        │   └── transactions/page.tsx
        ├── components/
        │   ├── ActivityFeed.tsx
        │   ├── LoanCard.tsx
        │   └── ...
        └── package.json
```

---

## MongoDB Schemas (5 collections)

### borrowers
```ts
{
  _id: ObjectId,
  borrowerId: "agent-a",
  walletAddress: "0x9a...",
  apiKey: "claw_xxx",            // borrower's Locus key (kept in env in practice)
  serviceUrl: "http://localhost:4001",
  status: "ACTIVE" | "DEFAULTED" | "SUSPENDED",
  score: 500,
  limit: 0,
  outstanding: 0,
  defaultCount: 0,
  registeredAt: Date,
  updatedAt: Date
}
// indexes: { borrowerId: 1 } unique, { walletAddress: 1 } unique
```

### loans
```ts
{
  _id: ObjectId,
  loanId: "L_0001",
  borrowerId: "agent-a",
  amount: 1.00,
  interestRate: 0.084,
  repayAmount: 1.0008,
  purpose: "wrapped-api/firecrawl-scrape",
  decisionToken: "dt_abc...",
  targetSessionId: "sess_merchant_xyz",
  disbursementTxHash: "0xfa...",
  repaymentSessionId: "sess_repay_xyz",
  repaymentTxHash: "0xc9...",
  status: "REQUESTED" | "FUNDED" | "REPAID" | "DEFAULTED",
  createdAt: Date,
  fundedAt: Date,
  dueAt: Date,
  closedAt: Date
}
// indexes: { loanId: 1 } unique, { borrowerId: 1, status: 1 }
```

### score_events
```ts
{
  _id: ObjectId,
  borrowerId: "agent-a",
  type: "session_paid" | "session_refunded" | "session_expired"
      | "loan_repaid" | "loan_defaulted" | "score_recomputed",
  delta: +3,
  reason: "on-time repayment of L_0001",
  source: "webhook" | "loop" | "manual",
  payload: { /* raw webhook for audit */ },
  createdAt: Date
}
// indexes: { borrowerId: 1, createdAt: -1 }
```

### transactions
```ts
{
  _id: ObjectId,
  type: "draw" | "repayment" | "score_sale" | "default_writeoff" | "borrower_revenue",
  borrowerId: "agent-a" | null,
  amount: 1.00,
  sessionId: "sess_xxx" | null,
  txHash: "0x..." | null,
  locusTransactionId: "uuid" | null,
  status: "PENDING" | "CONFIRMED" | "FAILED",
  loanId: "L_0001" | null,
  createdAt: Date
}
// indexes: { createdAt: -1 }, { borrowerId: 1, createdAt: -1 }
```

### repayment_queue
```ts
{
  _id: ObjectId,
  loanId: "L_0001",
  borrowerId: "agent-a",
  repaymentSessionId: "sess_repay_xyz",
  amount: 1.0008,
  attempts: 0,
  maxAttempts: 4,
  nextAttemptAt: Date,
  state: "WAITING" | "ATTEMPTING" | "COMPLETED" | "FAILED",
  lastError: null,
  createdAt: Date,
  updatedAt: Date
}
// indexes: { state: 1, nextAttemptAt: 1 }, { loanId: 1 } unique
```

---

## Agent Logic (No LLMs)

### Credit Agent

**On `POST /credit/register`:** validate, upsert borrower with `score=500, limit=0`, return manifest.

**On `POST /credit/draw`:**
1. Look up borrower; reject if not ACTIVE.
2. `availableCredit = limit - outstanding`. Reject if `amount > availableCredit`.
3. Compute rate via policy.
4. Generate `decisionToken` = HMAC-SHA256(`borrowerId|amount|rate|expires`, SECRET), 60s TTL.
5. Return `{ approved, decisionToken, rate, repayAmount, dueAt }`. No money moves.

**On `POST /credit/fund`:**
1. Verify decisionToken HMAC + not expired.
2. `GET /api/checkout/agent/preflight/:targetSessionId` on Credit's account. Confirm `canPay:true` and amount matches within ±$0.01.
3. `POST /api/checkout/agent/pay/:targetSessionId` from Credit's wallet. Capture `transactionId`.
4. Poll `GET /api/checkout/agent/payments/:transactionId` until `CONFIRMED`. Capture `txHash`.
5. Create repayment session: `POST /api/checkout/sessions` (Credit as merchant, amount=repayAmount, line items "Repayment of L_xxxx"). Capture `repaymentSessionId`.
6. Insert loan + repayment_queue docs.
7. Update `borrowers.outstanding += repayAmount`.
8. Push SSE `loan.funded`. Return loan record.

**On `GET /score?wallet=0x...`:** return free thin summary.

**On `POST /score-report`:** create $0.01 Locus session for full report; return `{ sessionId, payUrl }`.

**On `POST /webhooks/locus`:** verify HMAC; switch by event type:
- `checkout.session.paid` matching repayment session → mark loan REPAID, decrement outstanding, score event +5
- matching score-report session → mark report claimable
- matching borrower's customer session → score event +3, log borrower_revenue
- `checkout.session.expired` for borrower customer session → score -2

### Background Loops

**collection-loop (every 10s):** for each `repayment_queue.state=WAITING && nextAttemptAt<=now`:
1. Set `state=ATTEMPTING`, `attempts++`.
2. `GET /api/pay/balance` against borrower's account.
3. If sufficient: `POST /api/checkout/agent/pay/:repaymentSessionId` against borrower's account. Mark `state=COMPLETED`. Webhook will close loan.
4. If insufficient: if `attempts >= maxAttempts`, default loan (-80 score, broadcast). Else schedule `nextAttemptAt = now + backoff(attempts)`. Backoff: [30s, 60s, 120s, 300s].

**score-recompute-loop (every 30s):** recompute every borrower's score from `score_events`. Recompute `limit = max(0, min((score-500)*0.5, MAX_LOAN_USDC * 4))` — the cap keeps display meaningful relative to the system's actual max-loan size (otherwise a 580-score borrower would show a $40 limit while we only ever issue $0.05 loans). Emit SSE `score.changed` if changed.

**default-loop (every 60s):** force-default any open loan past `dueAt + grace`.

### Borrower Agents (A and B)

**On boot:** fetch manifest, register with Credit.

**On `POST /work`:**
1. `WORK_PRICE` and `WORK_COST` from env.
2. Create Locus session on own account (`POST /api/checkout/sessions`, amount=WORK_PRICE).
3. Return `402 Payment Required` with `{ sessionId, payUrl, preflightUrl, amount, currency, lineItems }`. **This is the machine-readable discovery surface.**

**On `POST /webhooks` (own session.paid):**
1. Verify HMAC.
2. Look up job by sessionId.
3. Decide whether to borrow:
   - `Need = WORK_COST - currentBalance + SAFETY_BUFFER`.
   - If `Need <= 0`: skip borrow.
   - If `Need > 0`: `POST /credit/draw`. If approved: create internal "cost session" → `POST /credit/fund`. Credit pays into our wallet.
4. Call mocked work (sleep 1s + canned response).
5. POST result to original customer's callback.

### Customer Agent

Two modes:
- **Continuous (cron):** every 20s, weighted-pick a borrower, hit `/work`, get 402, preflight, pay session.
- **Manual:** `POST /trigger` for demo control.

---

## Policy Function

```ts
function rateFor(score: number): number {
  if (score >= 800) return 0.05;
  if (score >= 700) return 0.08;
  if (score >= 600) return 0.12;
  if (score >= 500) return 0.18;
  return 0.99; // not lendable
}

function repayAmount(principal: number, rate: number, ttlSeconds: number): number {
  const accrued = principal * rate * (ttlSeconds / (365 * 24 * 3600));
  return Math.max(principal + 0.0001, principal + accrued);
}
```

---

## Score Function

Score in [300, 850]. Cold-start = 500. Recomputed every 30s from score_events.

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

## API Contracts

### Credit Agent

```http
GET /.well-known/locus-credit.json
200 OK
{
  "creditAgent": "https://credit-agent.example",
  "endpoints": {
    "register": "POST /credit/register",
    "draw":     "POST /credit/draw",
    "fund":     "POST /credit/fund",
    "score":    "GET  /score?wallet=0x...",
    "report":   "POST /score-report"
  },
  "terms": { "minScore": 500, "maxLoanUsdc": 200, "maxTtlSeconds": 86400 }
}
```

```http
POST /credit/register
{ "borrowerId": "agent-a", "walletAddress": "0x9a...", "serviceUrl": "http://localhost:4001", "registrationApiKey": "claw_..." }
200 → { "ok": true, "score": 500, "limit": 0 }
```

```http
POST /credit/draw
{ "borrowerId": "agent-a", "amount": 1.00, "purpose": "wrapped-api/firecrawl-scrape", "ttl": 3600 }
200 → { "approved": true, "decisionToken": "dt_abc.signature", "amount": 1.00, "rate": 0.084, "repayAmount": 1.0008, "expiresAt": "...", "dueAt": "..." }
403 → { "approved": false, "reason": "insufficient_credit_limit", "limit": 0, "outstanding": 0 }
```

```http
POST /credit/fund
{ "decisionToken": "dt_abc.sig", "targetSessionId": "sess_merchant_xyz" }
200 → { "loanId": "L_0001", "disbursement": { "transactionId": "uuid", "txHash": "0xfa...", "status": "CONFIRMED" }, "repaymentSessionId": "sess_repay_xyz", "repayAmount": 1.0008, "dueAt": "..." }
```

```http
GET /score?wallet=0x9a...
200 → { "score": 715, "tier": "PRIME", "openLoans": 1, "defaultCount": 0, "lastUpdate": "..." }
```

```http
POST /score-report
{ "wallet": "0x9a..." }
200 → { "sessionId": "sess_scs_77", "payUrl": "https://beta.paywithlocus.com/pay/sess_scs_77", "amount": 0.01, "currency": "USDC" }

GET /score-report/sess_scs_77/result
200 → { "wallet": "0x9a...", "score": 715, "components": {...}, "events": [...] }
```

```http
POST /webhooks/locus
Headers: { "x-locus-signature": "sha256=..." }
Body: { "type": "checkout.session.paid", "data": { "sessionId": "...", ... } }
200 OK
```

```http
GET /events     // SSE stream
data: { "kind": "loan.funded", "loanId": "L_0001", "borrowerId": "agent-a", ... }
data: { "kind": "score.changed", "borrowerId": "agent-a", "from": 712, "to": 715 }
data: { "kind": "loan.repaid",  "loanId": "L_0001", "txHash": "0xc9..." }
data: { "kind": "loan.defaulted", "loanId": "L_0042", "borrowerId": "agent-b" }
```

### Borrower (A and B)

```http
POST /work
{ "url": "https://example.com/article" }
402 Payment Required
{
  "sessionId": "sess_borrower_aaa",
  "payUrl": "https://beta.paywithlocus.com/pay/sess_borrower_aaa",
  "preflightUrl": "https://beta-api.paywithlocus.com/api/checkout/agent/preflight/sess_borrower_aaa",
  "amount": 1.50,
  "currency": "USDC",
  "lineItems": [{ "description": "Web scrape", "amount": "1.50" }]
}

POST /webhooks   // HMAC-verified Locus webhook
```

### Customer Agent

```http
POST /trigger
{ "borrowerId": "agent-a", "url": "https://..." }
200 → { "queued": true, "willPaySessionId": "sess_borrower_aaa" }
```

---

## Background Job Pseudocode

```ts
// collection-loop.ts (in Credit Agent)
cron.schedule('*/10 * * * * *', async () => {
  const due = await RepaymentQueue.find({
    state: 'WAITING', nextAttemptAt: { $lte: new Date() }
  }).limit(20);

  for (const item of due) {
    item.state = 'ATTEMPTING'; item.attempts++; await item.save();
    const borrower = await Borrower.findOne({ borrowerId: item.borrowerId });

    try {
      const balance = await locus.balance(borrower.apiKey);
      if (balance >= item.amount) {
        const pay = await locus.agentPay(borrower.apiKey, item.repaymentSessionId);
        await locus.waitForConfirm(borrower.apiKey, pay.transactionId, 30_000);
        item.state = 'COMPLETED'; await item.save();
        // loan closure happens via webhook handler when session.paid fires
      } else {
        if (item.attempts >= item.maxAttempts) {
          item.state = 'FAILED'; await item.save();
          await defaultLoan(item.loanId);
        } else {
          item.state = 'WAITING';
          item.nextAttemptAt = new Date(Date.now() + backoff(item.attempts));
          await item.save();
        }
      }
    } catch (err) {
      item.state = 'WAITING'; item.lastError = String(err);
      item.nextAttemptAt = new Date(Date.now() + 30_000);
      await item.save();
    }
  }
});

function backoff(n: number): number {
  return [30, 60, 120, 300][Math.min(n-1, 3)] * 1000;
}
```

```ts
// score-recompute-loop.ts
cron.schedule('*/30 * * * * *', async () => {
  const borrowers = await Borrower.find({ status: 'ACTIVE' });
  for (const b of borrowers) {
    const newScore = await computeScore(b.borrowerId);
    if (newScore !== b.score) {
      const old = b.score;
      b.score = newScore;
      b.limit = Math.max(0, (newScore - 500) * 0.5);
      await b.save();
      sseBus.emit({ kind: 'score.changed', borrowerId: b.borrowerId, from: old, to: newScore });
    }
  }
});
```

---

## Frontend Pages

1. **`/` Dashboard** — system pulse + live activity feed via SSE.
2. **`/agents/[id]`** — per-agent identity, financials, credit profile, recent loans.
3. **`/score/[wallet]`** — score card, components, public events, "Buy full report" button (real Locus checkout).
4. **`/flow`** — **demo centerpiece.** Five horizontal cards (REQUEST → APPROVED → FUNDED → COMMIT → REPAID) lighting up in sequence, with raw JSON console below showing every API call. [Run another loan] and [Trigger default scenario] buttons.
5. **`/transactions`** — flat ledger with filters and BaseScan links.

For each loan card, render three Locus session IDs side-by-side: target session, repayment session, and customer revenue session. Each shows status, amount, line items, payer/merchant wallets, txHash (BaseScan link), expiration, raw JSON toggle.

---

## Two-Day Build Plan

### Day 1 — Get money to move

| Block | Hours | Task |
|---|---|---|
| Setup | 0–1 | pnpm workspace, MongoDB Atlas free tier, 4 Locus beta accounts, fund each with beta credits |
| Locus client | 1–3 | `packages/shared/src/locus/client.ts` — wrap balance, send, sessions/create, sessions/get, agent/preflight, agent/pay, payments/:id, webhook HMAC |
| DB schemas | 3–4 | Mongoose models for all 5 collections + indexes |
| Credit Agent skeleton | 4–7 | Fastify app, register/draw/fund/score routes (decisions only, no money yet), webhook stub, SSE endpoint |
| **Real Checkout flow** | 7–11 | `/credit/fund` end-to-end: preflight → agent-pay → create repayment session → persist. **Test on real beta — see USDC actually move on Base.** |
| Borrower A | 11–14 | `/work` → 402 with session, webhook handler, decide-borrow logic, mocked work() |
| Customer Agent | 14–16 | `/trigger` + cron driver; preflight + agent-pay against borrower sessions |
| Repayment loop | 16–19 | Cron: poll borrower balance, agent-pay repayment session |
| Score loop + webhooks | 19–22 | Webhook dispatch + score recompute |
| Smoke test | 22–24 | End-to-end happy path. Confirm 4 separate BaseScan tx hashes per loan cycle. |

### Day 2 — Make it visible and bulletproof

| Block | Hours | Task |
|---|---|---|
| Frontend scaffold | 0–3 | Next.js + Tailwind + SSE consumer hook |
| Dashboard + activity feed | 3–5 | SSE feed + top tickers |
| Agent view + score page | 5–8 | Per-borrower views; score components as bars |
| **Loan Flow page** | 8–13 | 5-card sequence + raw JSON console + demo control buttons |
| Borrower B + default path | 13–16 | Thin-margin env, verify natural defaults, tighten retry timing for live demo |
| Score-as-a-service | 16–18 | Paid `/score-report` flow, judge clicks Locus pay link, full report unlocks |
| Polish + buffer | 18–22 | Error handling, SSE reconnect, BaseScan deep links |
| Rehearsal + record | 22–24 | Full demo 5×, record clean fallback, submit to Devfolio |

### What to mock

- **Wrapped API** — `do-work.ts` is `await sleep(1000); return { content: "Mock scraped article" }`. Saves 3h.
- **Score subscriptions** — one-time `/score-report` only.
- **Payment Router on-chain events** — webhooks alone are sufficient.
- **Default broadcast** — public JSON file at `/scores/defaulted.json`, no fanout.

### What absolutely must work live

1. One disbursement with real BaseScan tx hash.
2. One auto-collected repayment with real BaseScan tx hash.
3. One score change driven by real webhook.
4. One paid score report unlocked through Locus checkout.

---

## ENV Templates

```ini
# packages/credit-agent/.env
PORT=4000
MONGODB_URI=mongodb+srv://...
LOCUS_API_KEY=claw_credit_...
LOCUS_API_BASE=https://beta-api.paywithlocus.com/api
LOCUS_WEBHOOK_SECRET=whsec_...
DECISION_TOKEN_SECRET=long_random_string
PUBLIC_BASE_URL=https://credit.example.com
FRONTEND_ORIGIN=https://credit-frontend.vercel.app

# packages/borrower-a/.env
PORT=4001
BORROWER_ID=agent-a
LOCUS_API_KEY=claw_borrower_a_...
LOCUS_WEBHOOK_SECRET=whsec_a_...
LOCUS_API_BASE=https://beta-api.paywithlocus.com/api
WORK_PRICE=1.50
WORK_COST=1.20
SAFETY_BUFFER=0.10
CREDIT_AGENT_URL=http://localhost:4000

# packages/borrower-b/.env  — thin margin, will default sometimes
PORT=4002
BORROWER_ID=agent-b
WORK_PRICE=1.40
WORK_COST=1.20
SAFETY_BUFFER=0.10

# packages/customer-agent/.env
PORT=4003
LOCUS_API_KEY=claw_customer_...
LOCUS_API_BASE=https://beta-api.paywithlocus.com/api
BORROWER_A_URL=http://localhost:4001
BORROWER_B_URL=http://localhost:4002
CONTINUOUS_MODE=true
JOB_INTERVAL_SECONDS=20
```

---

## The Four Checkout Flows (the hero)

**Flow A — Customer pays Borrower (machine-readable discovery + agent-pay)**
1. Customer hits `Borrower /work` → `402 + sessionId`.
2. Customer calls `agent/preflight/:sessionId` → reads canPay, amount, line items.
3. Customer calls `agent/pay/:sessionId` → USDC moves on Base.
4. Borrower's webhook fires → delivers result.

**Flow B — Credit funds session for borrower (preflight-as-fraud-check + agent-pay)**
1. Borrower runs short, calls `/credit/draw` → decisionToken.
2. Borrower creates internal cost session.
3. Borrower calls `/credit/fund {decisionToken, targetSessionId}`.
4. Credit calls `agent/preflight/:targetSessionId` (verifies amount + merchant).
5. Credit calls `agent/pay/:targetSessionId` → Credit's wallet → borrower's wallet.
6. Borrower can now do the work.

**Flow C — Borrower repays Credit (programmatic create + scheduled agent-pay)**
1. At fund time, Credit created repayment session via `POST /checkout/sessions` (Credit as merchant).
2. Collection loop polls borrower balance.
3. When sufficient, Credit calls `agent/pay/:repaymentSessionId` using **borrower's** API key.
4. USDC moves borrower → Credit. Webhook closes loan.

**Flow D — Score-as-a-service (drop-in React component)**
1. Frontend `POST /score-report` → `{sessionId, payUrl}`.
2. Page mounts `@withlocus/checkout-react` component on that session.
3. Judge clicks pay → Locus handles wallet + on-chain confirmation.
4. Webhook → Credit marks report claimable.
5. Frontend hydrates full report inline.

This is the only flow using the React SDK — the explicit star of the Week 3 prompt. Together with A–C it proves understanding of both halves of CheckoutWithLocus: buyer-as-agent (programmatic) and buyer-as-human (React drop-in).

---

## README Notes

In the final README:
- Architecture diagram identical to above.
- Ordered list of every Locus endpoint hit, with one-line war story per endpoint.
- "What Locus Owns vs What We Own" table — our backend never touches USDC.
- Score formula in plain text.
- "Why this couldn't be Stripe" — programmable buyer-side preflight, agent-paid sessions on behalf of pre-authorized wallets, machine-readable session metadata. Stripe has none of these.

---

## Starting Point

First file to write: `packages/shared/src/locus/client.ts`. Every other file depends on it.

Order of attack:
1. Locus client wrapper (with HMAC verify helper).
2. Mongoose models.
3. Credit Agent `/credit/fund` end-to-end against real beta — prove USDC moves before doing anything else.
4. Borrower A `/work` 402 + decide-borrow.
5. Customer Agent driver.
6. Collection loop.
7. Webhooks.
8. Frontend.

- 2026-04-29: GET /api/checkout/agent/preflight/:id confirmed FLAT envelope.
  Shape: { canPay, agent: { walletAddress, availableBalance }, session: {
  id, amount, currency, description, status, expiresAt, sellerWalletAddress },
  blockers? }. Preflight session subset uses sellerWalletAddress (NOT
  merchantAddress); description can be null; availableBalance returns
  "999999" as a sentinel for no-allowance, NOT real balance.
- DESIGN DECISION: metadata field on createSession round-trips intact through
  getSession. We use it as our loanId carrier — store { loanId, borrowerId,
  purpose } in metadata at createSession time, read it back in webhook
  handlers to route events without a separate sessionId→loanId lookup table.