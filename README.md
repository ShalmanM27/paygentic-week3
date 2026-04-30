# CREDIT — Agent Marketplace + Credit Platform

> An open marketplace where AI agents pay each other in USDC, with autonomous credit lines for when they run low.

Built for the Locus Paygentic Week 3 hackathon (**CheckoutWithLocus** track).

---

## What this is

A working agent marketplace. Three things that have never existed in one project before:

1. **An agent marketplace with escrow** — buyers pay the credit platform upfront, output is verified before funds release to the agent.
2. **An autonomous credit line for agents** — when an agent's wallet is too low to fulfill a task, it borrows from the credit platform mid-flight, completes the work, and repays automatically from earnings.
3. **A multi-tenant rent model** — operators register their own agents and pay monthly hosting rent in USDC. New agents flip live the moment rent settles on-chain.

Six load-bearing CheckoutWithLocus flows. Every byte of value moves through Locus.

---

## Live evidence

Real on-chain transactions during development (USDC on Base):

| Session | Amount | Type | Tx |
|---|---|---|---|
| `9e921487…` | $0.05 | Wallet seed → borrower-a | [BaseScan](https://basescan.org/tx/0x9e921487855b40abb8d57be2591024b5) |
| `74b5da34…` | $0.03 | Wallet seed → borrower-b | [BaseScan](https://basescan.org/tx/0x74b5da34723f4b47b309b410cbf916b0) |
| `d788fbd6…` | $0.05 | Wallet seed → customer | [BaseScan](https://basescan.org/tx/0xd788fbd694414554b74b43232a39fb95) |
| `cdc7fad2…` | $0.005 | smoke-pay (customer→credit) | [BaseScan](https://basescan.org/tx/0xcdc7fad263f64dfe9f06eac9d8661254) |
| `9602f71d…` | $0.005 | smoke-pay (customer→credit) | [BaseScan](https://basescan.org/tx/0x9602f71d) |
| `51573df7…` | $0.005 | smoke-pay (customer→credit) | [BaseScan](https://basescan.org/tx/0x51573df7) |

Diagnostic + seeding spend: **~$0.020 USDC**. Live dress-rehearsal: TBD (will add escrow paid + escrow released hashes here after the live run).

---

## Architecture

Six CheckoutWithLocus flows. Every dollar in or out of the system flows through a Locus session.

```
                                   ┌──────────────────┐
                              7.   │   OPERATOR       │ ── pay $0.005/mo rent ──┐
                          register │   (third-party)  │                         │
                          new agent└──────────────────┘                         │
                                                                                ▼
   USER (browser)                                              ┌────────────────────────┐
       │                                                       │   LOCUS BETA           │
       │  1. Pay escrow $0.0080 USDC (UI Checkout)             │   beta-api.paywithlocus.com
       ▼                                                       │   - sessions, agentPay │
  ┌────────────────────────┐                                   │   - getSession polling │
  │   CREDIT PLATFORM      │ ── 3. Disburse loan if needed ──▶ └────────────────────────┘
  │   (escrow + lender)    │                                              ▲
  │                        │ ◀── 4. Repay loan + interest ──┐             │
  │   Mongo Atlas-backed   │                                │             │
  │   In-process queue     │ ◀── 5. Deliver output ──┐      │             │
  │   Cron loops:          │     (verified by us)    │      │             │
  │     collection · 10s   │                         │      │             │
  │     score · 30s        │ ── 6. Release escrow ───┼──┐   │             │
  │     defaults · 60s     │     to agent wallet     │  │   │             │
  │     escrow-watcher · 3s│                         │  │   │             │
  │     subscription · 3s  │ ── 8. Sell score ──┐    │  │   │             │
  └────────────────────────┘     ($0.01)        │    │  │   │             │
       │                                        │    │  │   │             │
       │    8. Pay for score report ────────────┘    │  │   │             │
       │                                             │  │   │             │
       │    AGENT SERVICE (Gemini Flash, direct API)─┴──┘   │             │
       │      summarizer :4001  code-reviewer :4002        │             │
       │      code-writer :4004                             │             │
       └────────────────────────────────────────────────────┘             │
                                                                          │
                              every USDC movement above   ────────────────┘
                              hits Locus
```

Six flows: **(1)** buyer→escrow, **(3)** credit→agent disbursement, **(4)** agent→credit repayment, **(6)** credit→agent escrow release, **(7)** operator→credit rent, **(8)** buyer→credit score-report.

---

## Tech stack

- **Backend** — Node.js 20 + TypeScript + Fastify + Mongoose
- **Database** — MongoDB Atlas (free tier M0)
- **Frontend** — Next.js 14 + Tailwind + Locus Checkout React SDK
- **LLM** — Gemini 1.5 Flash via Google AI Studio direct (free tier, ~$0)
- **Blockchain** — USDC on Base
- **Payments** — Locus Checkout (beta API)
- **Tests** — 8 in-process acceptance tests, all sequential, ~5 min total

---

## Three innovations

### 1. Multi-tenant agent hosting via shared wallets

Four Locus beta accounts; three active agents. **Operator A** (`claw_dev_E6s` key) hosts both Summarizer and Code Writer — same wallet, two services. **Operator B** (`claw_dev_98T`) hosts Code Reviewer alone. This proves the platform's "anyone can host" thesis: a single operator can list multiple agents under one wallet, and the marketplace surfaces them as independent products.

### 2. Autonomous credit line, mid-task

A buyer pays escrow but the agent's wallet is below cost-to-serve. Without intervention, the task would fail. Instead the agent autonomously:

1. `POST /credit/draw` (with `linkedTaskId` for traceability) → 60s HMAC decision token
2. `POST /credit/fund` → credit pays the agent's cost-cover session via `agentPay`
3. Completes the work, returns the output to credit
4. Credit verifies → releases escrow (`$0.0080`) to agent wallet
5. `collection-loop` ticks within 10s, agent autorepays (`$0.0080 + accrued interest @ 18% APR`)

No human triggers. Every state transition emits an SSE event the frontend renders live. The full cycle takes about 7 seconds in offline mode and tested clean against beta in the smoke runs above.

### 3. Verified delivery before escrow release

Outputs are checked for refusal patterns (`I cannot…`, `As an AI…`), minimum length (≥20 chars), and maximum length (≤50000 chars) before credit releases funds. Failed verification → task `FAILED → REFUNDED`. Production would swap in LLM-as-judge or human-in-loop; this is the explicit hackathon-grade placeholder.

---

## What we built but didn't ship

### Refund-to-user (on-chain)
We capture `payerWalletAddress` defensively from the PAID session response. The refund route exists. But Locus beta doesn't guarantee that field, so refunds for some sessions execute as cosmetic-only (DB marked `REFUNDED`, no on-chain transfer). Production: require buyer to register a refund address upfront, OR use Locus's recipient-claim flow once shipped.

### Real webhook delivery
Locus's docs describe `webhookSecret` returned on `createSession` and `checkout.session.paid` events. Beta doesn't implement webhooks. We built and tested the HMAC handler; it's defense-in-depth code ready for the day Locus ships them. See `routes/webhooks.ts`.

### Rent renewal
Subscriptions cover 30 days. There's no auto-renewal job — when coverage ends, the agent should flip back to inactive. For a hackathon demo this is invisible; documented as a noted gap.

---

## War stories — what we learned about beta

Honest about the platform quirks we hit. All confirmed with the Locus team where possible.

### The 403 polling bug
`GET /checkout/agent/payments/:transactionId` returns **403 "Transaction does not belong to this agent"** for both the buyer and the merchant — for transactions we genuinely initiated and that settled on-chain. Confirmed beta bug; Locus team has our feedback (id `95a8f43f-…`). We pivoted to `GET /checkout/sessions/:id` polling, which is the documented fallback and exposes `paymentTxHash` directly on the PAID response.

### The webhook gap
`webhookSecret` is silently dropped on `createSession`; no `whsec_` is ever returned. `checkout.session.paid` events don't fire in beta. We chose `getSession` polling as the primary confirmation mechanism. Settlement-watcher remains as defense-in-depth (default off).

### The wrapped-Gemini cost surprise
Locus's `/api/wrapped/gemini/chat` charges ~**$0.094 USDC per call** (verified live: 403 "Insufficient USDC balance" on the first hop). With 3 agents × 4–8 calls per demo run, the wrapped surface alone would have exceeded our hackathon USDC budget. We pivoted to direct Google AI Studio (free tier, 1500 calls/day, $0). Architectural integrity is preserved: the LLM is the work the agent performs, and a production operator can swap the wrapped API back in with one env-flag change in `do-work.ts`. Every byte of *value* still flows through Locus.

### The casing zoo
Different Locus endpoints use different casing for both fields and status enums:

| Endpoint | Body casing | Status enum |
|---|---|---|
| `GET  /pay/balance` | snake | n/a |
| `POST /pay/send` | snake | UPPERCASE |
| `POST /checkout/sessions` | camel | UPPERCASE |
| `GET  /checkout/sessions/:id` | camel | UPPERCASE |
| `GET  /checkout/agent/preflight/:id` | camel (flat envelope) | UPPERCASE |
| `POST /checkout/agent/pay/:id` | camel | **lowercase** |
| `GET  /checkout/agent/payments/:id` | 403 in beta — unusable | — |

We empirically mapped each one. See `CLAUDE.md` for the full table.

---

## Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- MongoDB Atlas connection string
- Four Locus beta accounts (`claw_…` keys) — one for credit-agent, two operator wallets sharing across three agents, one customer
- Google AI Studio API key (free tier — `https://aistudio.google.com`)

### Install

```bash
pnpm install
```

### Configure

Copy `.env.example` files and fill in keys for each package:

```bash
cp packages/credit-agent/.env.example packages/credit-agent/.env
cp packages/borrower/.env.example packages/borrower/.env
cp packages/customer-agent/.env.example packages/customer-agent/.env
# then edit each to set MONGODB_URI, LOCUS_API_KEY, GEMINI_API_KEY, ...
```

---

## Run

### Offline mode (development & demo default)

```bash
pnpm demo                          # boots all 5 backends in one process
pnpm dev:web                       # frontend on :3000
```

Open `http://localhost:3000`. The home page shows three built-in agents and a green/gray banner indicating live or offline mode.

### Pre-demo health check

```bash
pnpm verify                        # typecheck + boot + ping all 5 services + Mongo + Gemini
```

Exits with green/red summary. Use before any live run.

### Reset demo state mid-session

```bash
pnpm reset-and-run                 # truncates per-task DB state, re-seeds borrowers
```

### All tests

```bash
pnpm test:all                      # 8 acceptance tests, sequential, ~5 min
```

### Live mode (real USDC on Base)

See **`packages/credit-agent/scripts/live-mode-checklist.md`** for the full checklist. The short version:

1. `pnpm test:all` → green
2. Verify wallet balances (credit-agent ≥ $4, your buyer wallet ≥ $0.05)
3. Edit `packages/credit-agent/.env`: `LOCUS_OFFLINE_MODE=0`
4. Restart `pnpm demo` — banner should flip from gray "Offline mode" to green "LIVE MODE — real USDC on Base"
5. Use the marketplace happy path (Pay $0.0080 → watch the timeline → see agent's real Gemini output)
6. After: flip back to `LOCUS_OFFLINE_MODE=1`

---

## Demo path (90 seconds)

1. Open `http://localhost:3000` — see marketplace with 3 agent cards
2. Click **Use this agent →** on **Summarizer**
3. Paste a paragraph (≥10 chars)
4. Click **Pay $0.0080 & submit task**
5. Locus Checkout SDK widget mounts. Pay (or click "Simulate payment" in offline mode)
6. Redirected to `/tasks/T_NNNN` — watch the timeline progress live: **Paid → Dispatched → Processing → Delivered → Released**
7. Output renders below the timeline. In live mode, this is real Gemini-generated content.

### Backup demo (skips checkout)

`http://localhost:3000/flow` — five-card REQUEST → APPROVED → FUNDED → COMMIT → REPAID lend-and-repay sequence with a raw JSON console showing every API call. Click **[Run Loan]** to fire one cycle in ~7s.

### Operator view (admin)

`http://localhost:3000/admin/agents/[id]` — internal credit profile, score components, recent loans, balance refresh against Locus.

---

## File structure

```
packages/
  credit-agent/   the lender + scorer + escrow holder + rent collector
                   ├─ routes/   register, draw, fund, score, webhooks, tasks, agents (register), debug
                   ├─ jobs/     collection-loop, score-loop, default-loop, escrow-watcher, subscription-watcher
                   └─ scripts/  test-*, demo-runner, verify, reset-and-run, live-mode-checklist
  agent-summarizer/
  agent-code-reviewer/  three working LLM agents
  agent-code-writer/    (each is a thin entry point + .env over the shared borrower runtime)
  customer-agent/  legacy /flow demo trigger
  borrower/        shared agent runtime library — /work, /work-with-input, decide-borrow, do-work, credit-client
  shared/          types, models (8 collections), Locus client (live + mock), HMAC, score, policy, SSE bus

apps/
  frontend/        Next.js 14 — marketplace, agent detail, tasks, /add-agent, /admin, /flow, /transactions
```

---

## Test coverage (8 acceptance tests)

| Test | What it covers |
|---|---|
| `test:credit-flow` | borrower registration + decision token + fund cycle |
| `test:webhook-flow` | HMAC verify + score-report unlock + repayment closure (defense-in-depth) |
| `test:loops` | collection / score-recompute / default loops, four scenarios each |
| `test:borrow-flow` | borrower's `/work` 402 → webhook → draw + fund + work + callback |
| `test:e2e-loop` | credit + 3 agents + customer in one process, full cycle ≤12s |
| `test:frontend-routes` | `/agents/:id` + `/agents/:id/balance` + `/stats` + `/transactions` |
| `test:task-flow` | escrow flow — happy path, borrow mid-task, verification failure, session expiry |
| `test:add-agent` | built-in seed + register + rent payment + activation, plus expiry path |

Run any individually (`pnpm test:credit-flow`) or all sequentially (`pnpm test:all`).

---

## Architectural decisions

See `CLAUDE.md` for the full list with dates, reasoning, and trade-offs. Key ones:

- **Webhooks kept; not on critical path** — beta doesn't ship them yet
- **`getSession` polling is canonical confirmation** — the documented fallback that actually works in beta
- **LLM via Google AI Studio direct** — wrapped Gemini was prohibitively priced
- **Multi-tenant via shared wallets** — three agents on two operator wallets
- **Mock Gemini in offline mode** — tests never burn LLM quota
- **DB-backed agent registry with idempotent built-in seed** — operator-registered agents flip active on rent payment
- **Hackathon-grade verification** — regex/length checks, not LLM-as-judge

---

## Future work

- Real refund-to-user (requires buyer wallet pre-registration)
- Production LLM-as-judge verification
- Rent renewal (currently 30d, no auto-renewal job)
- Real webhook delivery (when Locus ships it)
- Multi-currency / multi-chain agent ecosystem
- Public API for third-party agents to register and bring their own service

---

## License & credits

Built solo for Locus Paygentic Week 3, 2026-04-29 → 2026-05-01.

Substrate: [Locus Checkout](https://beta.paywithlocus.com), [Base](https://base.org), [Google AI Studio](https://aistudio.google.com), [MongoDB Atlas](https://www.mongodb.com/atlas), [Next.js](https://nextjs.org), [Fastify](https://fastify.dev).
