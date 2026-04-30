# Locus Hosting Assessment

> Step 1 deliverable. Investigation only — no code changes applied.

## 1. Source

Raw `SKILL.md` saved at [`docs/locus-skill.md`](docs/locus-skill.md)
(26.8 KB, fetched HTTP 200 from `https://beta.buildwithlocus.com/SKILL.md`).

Companion guides referenced but **not** fetched per spec guardrails
(no extra network calls beyond the public root URL):

- `onboarding.md` · `agent-quickstart.md` · `billing.md` ·
  `deployment-workflows.md` · `monorepo.md` · `logs.md` ·
  `webhooks.md` · `addons.md` · `domains.md` · `git-deploy.md` ·
  `api-reference.md` · `troubleshooting.md` · `checkout.md`

The root SKILL.md alone contains enough to assess fit/effort.

---

## 2. What this onboarding actually offers

**Locus Build is a container PaaS** — not an agent registry, not a
marketplace. It deploys arbitrary Docker images (or builds from a
GitHub repo / git push) and gives each service:

- An auto-subdomain `https://svc-{id}.buildwithlocus.com` with HTTPS
  and WebSocket support
- Auto-injected sibling-service URLs (`{SERVICE_NAME}_URL` /
  `_INTERNAL_URL`) for service-to-service wiring without manual config
- Postgres / Redis addons via API (no Mongo addon mentioned)
- Health checks, scaling (min/max instances), and SSE status streams
- Custom domains (BYOD or purchase)

This is **infrastructure replacement** for our current `localhost:3000
/ :4000–4004` setup. It is not adjacent to or a successor of the
PayWithLocus Checkout product we already integrate with.

**Reading between the lines**: the same `claw_*` workspace key we use
for Checkout is also the workspace identity here. The two products
share auth and billing.

---

## 3. Required code/config changes

Bullet list of everything that must change to host CREDIT on Locus
Build:

- **MongoDB**: SKILL.md only mentions Postgres + Redis as addons. Our
  stack uses MongoDB Atlas — that *can* stay external (services would
  read `MONGODB_URI` from env vars), but it then sits outside the
  Locus deployment. Acceptable, no code change needed.
- **Containerize each service**: Locus needs a `Dockerfile` per
  service OR a `.locusbuild` monorepo manifest at the repo root. We
  currently have neither.
  - 1 Dockerfile for `credit-agent` (Fastify, port → 8080)
  - 1 Dockerfile for each of `agent-summarizer` / `agent-code-reviewer`
    / `agent-code-writer` (3 borrowers, port → 8080)
  - 1 Dockerfile for `customer-agent` (port → 8080)
  - 1 Dockerfile for `apps/frontend` (Next.js, port → 8080)
  - OR a single `.locusbuild` manifest declaring all 6 services
- **Port reassignment**: every service currently binds a hardcoded port
  (4000/4001/4002/4003/4004/3000). Locus injects `PORT=8080` and
  routes traffic only there. Each service must read `process.env.PORT`
  and ignore the hardcoded value. Some services already do
  (Next.js); some don't (Fastify uses `cfg.port` from a fixed env).
- **Service-to-service URLs**: borrower→credit calls currently use
  `http://localhost:4000`. After deployment, each borrower's
  `CREDIT_AGENT_URL` env must become `${{credit-agent.URL}}` (or the
  auto-injected `CREDIT_AGENT_URL`). The Frontend's
  `NEXT_PUBLIC_CREDIT_AGENT_URL` must point to the public
  `svc-*.buildwithlocus.com` of the credit-agent.
- **Architecture**: Locus runs on `linux/arm64` (AWS Graviton). If we
  build images locally for testing they need `--platform linux/arm64`
  or rely on Locus to build from source (recommended).
- **Public ingress for borrowers**: in our current design, the
  credit-agent dispatches tasks via HTTP POST to the borrower's
  `serviceUrl`. The DB-backed `serviceUrl` for built-in agents is
  hardcoded to `http://localhost:4001/4002/4004`. After hosting, those
  records must be updated to the public Locus URLs (or the seed code
  must read from env at boot).
- **CORS**: borrower services already have `@fastify/cors` registered
  (V2 fix). Frontend already calls borrower `/healthz`. Once URLs flip
  from `localhost:*` to public Locus subdomains, CORS still permits
  (origin: true). No change needed.
- **GitHub setup**: the easiest path is `POST /v1/projects/from-repo`
  with a `.locusbuild`. That requires the repo on GitHub with a Locus
  GitHub App installation. We don't currently have that wired.
- **Env vars**: `MONGODB_URI`, `LOCUS_API_KEY`, `LOCUS_WEBHOOK_SECRET`,
  `DECISION_TOKEN_SECRET`, `GEMINI_API_KEY`, `PUBLIC_BASE_URL`,
  `FRONTEND_ORIGIN` all need to be `PUT`/`PATCH`'d per service via
  `/v1/variables/service/:id`.
- **Health-check paths**: each Fastify service serves `/healthz`. We'd
  set `healthCheckPath: "/healthz"` on every service. Frontend serves
  `/` — default works.
- **`PUBLIC_BASE_URL`** in credit-agent (used to construct
  task-deliver callback URLs): would need to become the credit-agent's
  own auto-subdomain URL, fetched from `LOCUS_SERVICE_URL` env var
  Locus auto-injects.

---

## 4. Effort estimate

**90–150 minutes** for a working hosted demo. Breakdown:

- Write 6 Dockerfiles or one `.locusbuild` manifest: **30–45 min**
  (need to handle pnpm workspaces correctly, ensure `@credit/shared`
  builds before consumers).
- Adjust hardcoded ports → `process.env.PORT`: **10 min**.
- Fix built-in agent `serviceUrl` seeding to read from env or `LOCUS_*`
  templates: **15 min**.
- Push to GitHub, install GitHub App: **15 min** (assumes user owns
  a GH org/repo and is willing to wire it up).
- Create project + 6 services + set vars + wait for first deploy
  (~7 min × 6 services if sequential, faster if parallel): **30–45 min
  end-to-end including waits**.
- Verify cross-service wiring (frontend→credit, credit→borrowers,
  borrowers→credit): **10 min**.
- Smoke-test the marketplace happy path on hosted URLs: **10 min**.

**>60 minutes — flagged.** This is a real lift, not a 5-minute switch.

---

## 5. Risk to the working demo

**MEDIUM-HIGH** if attempted in place; **LOW** if done as a parallel
deploy.

Specific risks:

- **Hardcoded port refactor** touches every service entrypoint. If we
  miss one, that service won't bind on Locus. Reversible, but each
  rebuild costs 3–7 min on the hosted side.
- **`PUBLIC_BASE_URL` plumbing** — the credit-agent constructs callback
  URLs to itself. If the env var doesn't get the right value, dispatch
  callbacks 404 and tasks stall. We've debugged this exact class of
  bug locally.
- **First-deploy build failures**: Nixpacks auto-detection on a pnpm
  monorepo without a `Dockerfile` is a known stumbling block (the
  SKILL doc explicitly warns: *"Nixpacks was unable to generate a
  build plan for this app"*). We'd need either a hand-written
  Dockerfile per service or a careful `.locusbuild` with `path`
  per service.
- **Mongo Atlas accessibility**: our existing MONGODB_URI is on Atlas
  free tier. If Atlas IP allowlist isn't open to Locus's outbound
  range we'd need to widen it. (Atlas defaults often allow 0.0.0.0/0
  in dev; check.)
- **Locus Checkout SDK origin**: the checkout iframe / redirect URLs
  are tied to the buyer's wallet domain, not our hosting. Should be
  unaffected. **LOW** risk on this axis.
- **Existing local demo**: untouched as long as we don't alter env
  defaults. We can keep `pnpm demo` working locally while a Locus
  deploy runs in parallel.

The local demo + 8 backend tests would survive if we keep `process.env.PORT
?? <fallback>` fallbacks. The risk is mostly time, not breakage.

---

## 6. Payoff if we onboard successfully

- **Public URLs for the demo**. Judges/reviewers click a real link
  instead of asking us to screen-share. Big win for hackathon
  perception.
- **End-to-end live mode in the cloud**: PayWithLocus checkout SDK
  callbacks can land on a public origin, not localhost. Cross-origin
  iframe issues we hit (the FIX 0 CORS work in V2) become moot.
- **Seller-side credibility**: a hosted CREDIT marketplace at a
  `*.buildwithlocus.com` URL signals "this is a real product running
  on the platform we built on." Likely meaningful for a CheckoutWithLocus
  track judge.
- **Same-platform alignment**: hackathon submissions hosted on Locus's
  own PaaS (and using their Checkout) likely score higher on
  "uses-the-platform" rubrics, though we have no explicit rule that
  says so. Not a guarantee.
- **No automatic agent-registry visibility**: SKILL.md does NOT
  describe a marketplace where other Locus users discover our agents.
  This is purely deployment infra. So the payoff is hosting +
  credibility, not network effect.

---

## 7. What does the $6 credit buy?

Per SKILL.md billing pre-flight section:

- **Service cost: $0.25/month per service.**
- **New workspaces start with $1.00** (covers first 4 services).
- We'd need 6 services (credit-agent + 3 borrowers + customer +
  frontend) → **$1.50/month**.
- $6 credit funds: **~4 months** of full deployment, or **~24 services**
  for one month each.
- LLM/inference is NOT covered by Locus Build credits. SKILL.md does
  not mention inference billing at all (that's a separate Locus
  Checkout / wrapped-Gemini concern, which we deliberately bypass via
  Google AI Studio direct).
- For a hackathon demo running for ~1 week of judging: **~$0.35**.
  $6 is more than enough.

**Bottom line**: $6 covers the deploy comfortably. The cost question
is engineering time, not budget.

---

## 8. Recommendation: **ONBOARD LATER**

**Reasoning**: 90–150 minutes of focused work isn't a fit for a final
polish window before submission. The local demo path
(`/marketplace → /agent → /tasks/[id]`) is working, the V3.x visuals
are landing, and we have 8 green tests. Spending the next two hours
writing Dockerfiles and chasing first-deploy build errors trades a
known-good demo for a maybe-better one and risks shipping a half-deployed
mess.

**However**, if we have a clear ≥3-hour block remaining and want a
public URL on the submission form, the payoff is high — judge clicks a
link at `https://svc-credit-agent.buildwithlocus.com`, sees real CREDIT
running, and that lands harder than a localhost screenshot. The
$6 credit is fine; the engineering effort is the gate.

**Skip-now criteria** (any one met → ONBOARD LATER):
- Less than 2 hours of deep work remaining before submission
- Submission form doesn't require a public hosted URL
- We haven't pushed the repo to GitHub publicly

**Onboard-now criteria** (all required):
- ≥3 hours of focused time remaining
- Repo is on GitHub (or willing to push it)
- Comfortable with possible 30+ minutes debugging a first deploy

---

## 9. Next-step prompt (only if you say "ONBOARD NOW")

```
Onboard CREDIT to Locus Build. Sequential work, narrate each step.

1. Add a single root .locusbuild manifest declaring 6 services:
   credit-agent (path: packages/credit-agent), borrower-summarizer,
   borrower-code-reviewer, borrower-code-writer (each path:
   packages/agent-*), customer-agent (path: packages/customer-agent),
   frontend (path: apps/frontend). Each declares port: 8080,
   healthCheckPath: "/healthz" (or "/" for frontend), and the
   appropriate env-var template references using ${{<service>.URL}}.

2. Add per-service Dockerfile fallbacks (Locus may need them if
   Nixpacks can't auto-detect pnpm workspaces). Build pnpm install +
   workspace package builds + start command.

3. Make every Fastify entrypoint read PORT from env (default to
   existing per-service port for local dev). Apply to credit-agent
   index.ts, all 3 borrower services, customer-agent.

4. Update built-in agent seed (packages/credit-agent/src/lib/agent-
   registry.ts) to read serviceUrl from env vars
   SUMMARIZER_URL / CODE_REVIEWER_URL / CODE_WRITER_URL, falling
   back to localhost defaults so tests don't break.

5. Set NEXT_PUBLIC_CREDIT_AGENT_URL on the frontend service to
   ${{credit-agent.URL}}.

6. Push branch to GitHub. Output: confirm GH App install URL for
   the user (https://beta.buildwithlocus.com/integrations).

7. After GH App installed, call POST /v1/projects/from-repo with
   the GitHub repo, monitor each deploy until healthy or failed,
   report all 6 service URLs and any build errors.

8. After all healthy: smoke-test the marketplace happy path against
   the hosted URLs from a curl script. Report what worked and what
   didn't.

Stop after step 8. Do not modify backend logic. Do not run pnpm
test:* — typecheck only.

Set a hard time budget: 2 hours. If at the 90-minute mark we don't
have all services healthy, report current state and stop.
```

---

## 10. Guardrails honored

- ✅ No code changes
- ✅ No new packages installed
- ✅ Did not call any Locus API endpoint (only fetched the public
  SKILL.md root URL)
- ✅ Did not modify `LOCUS_OFFLINE_MODE`
- ✅ SKILL.md was reachable + public (no auth required)

Awaiting your decision before proceeding to step 2.
