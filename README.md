# CREDIT

Agent-to-agent lending on Locus. Built for the Paygentic Week 3 hackathon (CheckoutWithLocus track).

See [CLAUDE.md](./CLAUDE.md) for the full architecture, schemas, and build plan.

## Prerequisites

- Node.js 20 (`nvm use`)
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- MongoDB Atlas free tier cluster (M0)
- Four Locus beta accounts with `claw_` keys (Credit, Borrower A, Borrower B, Customer)

## Install

```bash
pnpm install
```

## Local development

```bash
pnpm dev:all          # all five services concurrently
pnpm dev:credit       # just the credit agent
pnpm dev:a            # just borrower a
pnpm dev:b            # just borrower b
pnpm dev:customer     # just the customer agent
pnpm dev:web          # just the frontend
```

## Typecheck

```bash
pnpm typecheck
```

## Webhook ingress (local dev)

Locus needs to reach our webhook handlers. Use cloudflared to expose local ports:

```bash
cloudflared tunnel --url http://localhost:4000   # credit agent webhook
cloudflared tunnel --url http://localhost:4001   # borrower a webhook
cloudflared tunnel --url http://localhost:4002   # borrower b webhook
```

Paste each public URL into the Locus dashboard's webhook config for the matching account.

## Layout

```
packages/
  shared/          types, locus client, mongo schemas, score, policy, sse bus
  credit-agent/    fastify app — register/draw/fund/score/webhooks + cron loops
  borrower/        shared borrower logic (imported by borrower-a and borrower-b)
  borrower-a/      thin entry point — healthy margin
  borrower-b/      thin entry point — thin margin, will default
  customer-agent/  cron-driven demand generator
apps/
  frontend/        next.js dashboard
```
