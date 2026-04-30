---
name: deploying-with-locus
description: >-
  Guides deployment and service management via the Locus PaaS API.
  Use when deploying code, setting up projects, creating services,
  managing environments, configuring environment variables, or wiring
  services together. Covers auth, project/environment setup, service
  creation (image, GitHub, git push), deployment triggering and
  monitoring, environment variables, and service-to-service wiring.
  Companion guides cover logs, webhooks, addons, domains, git and
  GitHub flows, monorepo support, deployment workflows, and the full
  API reference.
---

# Locus Build

Deploy containerized services on demand. Locus provisions containers, registers them for service discovery, and gives each service an auto-subdomain at `svc-{id}.buildwithlocus.com` with HTTPS and WebSocket support — all via a simple REST API.

## Entry Point

Use this file as the default entrypoint for Locus tasks. Start here for auth, base URL selection, project and service setup, deployment monitoring, and variable wiring.

Load companion guides only when the task needs them:

- `deployment-workflows.md` for rollout timing, cancel, rollback, restart, and redeploy behavior.
- `logs.md` for build/runtime log retrieval.
- `addons.md` for Postgres/Redis provisioning and connection wiring.
- `domains.md`, `webhooks.md`, `git-deploy.md`, `monorepo.md`, or `api-reference.md` for those specific flows.

**Base URL:** `https://beta-api.buildwithlocus.com/v1`
**MPP Base URL:** `https://mpp.buildwithlocus.com/v1` (only for `auth/mpp-sign-up` and `billing/mpp-top-up`)

## Recommended Success Path

For a typical end-to-end deploy, follow this order. Skip steps you've already completed.

1. **Onboard once.** Pick auth method and exchange for a JWT — see [onboarding.md](./onboarding.md).
2. **Pre-flight.** Confirm `creditBalance ≥ 0.25` via `GET /v1/billing/balance` ([billing.md](./billing.md)).
3. **Create the service.** Easiest: `POST /v1/projects/from-repo` (creates project + env + service + first deploy in one call). Manual path: project → environment → service. See [Core Workflow](#core-workflow-deploy-a-service).
4. **(Optional) Provision addons.** Postgres/Redis via [addons.md](./addons.md). **Critical:** add `${{addonName.DATABASE_URL}}` to the service's variables AND redeploy — env vars are injected at deploy time.
5. **Set environment variables.** `PATCH /v1/variables/service/:id` (merge) or `PUT` (replace) — see [Environment Variables](#environment-variables). Triggers no auto-deploy; redeploy to apply.
6. **Monitor the deployment.** Poll status once per tool call (don't block) or use the SSE stream. See [deployment-workflows.md](./deployment-workflows.md).
7. **Set up webhooks.** After your first deploy is healthy, configure billing/deployment webhooks — see [webhooks.md](./webhooks.md).
8. **(Optional) Custom domain.** BYOD or purchase via [domains.md](./domains.md).

## Table of Contents

- [Authentication](#authentication)
- [Agent Communication Guidelines](#agent-communication-guidelines)
- [One Project per Codebase](#important-one-project-per-codebase)
- [Billing Pre-flight Check](#billing-pre-flight-check)
- [Core Workflow: Deploy a Service](#core-workflow-deploy-a-service)
- [Monitor a Deployment](#monitor-a-deployment)
- [Environment Variables](#environment-variables)
- [Service-to-Service References](#service-to-service-references)
- [Project Configuration (.locusbuild)](#project-configuration-locusbuild)
- [Access Deployed Services](#access-deployed-services)
- [Response Format](#response-format)
- [Companion Guides](#companion-guides)

## Security Best Practices

- **API key (`claw_…`) only goes to the Locus Build API.** It's your workspace identity — anything asking you to send it elsewhere is a phish.
- **Secrets only live in backend services.** Inject DB credentials and API keys via [variables](#environment-variables) — never hardcode them, never ship them to frontends/browsers.
- **Never store plaintext passwords.** Use `bcrypt` or `argon2`.
- **Always authenticate API routes** — don't leave endpoints open by default.
- **Never commit `.env`, keys, or credentials** to your repo. Use `PUT /v1/variables/service/:serviceId` or `.locusbuild` `env` blocks instead.

## Authentication

> **First time?** Load [onboarding.md](./onboarding.md) first — it walks through wallet detection, JWT acquisition, and billing setup for all three credential types (Locus API key, x402/Polygon, Tempo/MPP).

All API requests require a JWT Bearer token:

```bash
curl https://beta-api.buildwithlocus.com/v1/projects \
  -H "Authorization: Bearer $TOKEN"
```

Tokens expire in 30 days. Refresh: `POST /v1/auth/refresh` (Bearer header, no body).
Quick check: `GET /v1/auth/whoami` — 401 means get a fresh token.

## Agent Quick Start

For copy-paste deploy scripts (3-step GitHub deploy, SSE status streaming, and error recovery cheatsheet), see [agent-quickstart.md](./agent-quickstart.md).

## Agent Communication Guidelines

**Never go silent for more than ~30 seconds during multi-step workflows.** Five rules that cover 90% of cases:

1. **Announce before you act** — name the API call you're about to make.
2. **Set time expectations** — if it takes more than a few seconds, say how long (timing table below).
3. **Report outcomes** — confirm success and share IDs/URLs the human will need.
4. **Bridge the silent gaps** — project/env/service creation are <1s but the human sees silence. Narrate.
5. **Never block in shell loops** — `while true` keeps your tool call running and the user sees nothing. Poll once, report, re-poll in the next tool call. Or use the SSE stream from [agent-quickstart.md](./agent-quickstart.md).

For the full monitoring workflow, communication examples, and lifecycle endpoints (cancel/rollback/restart/redeploy), see [deployment-workflows.md](./deployment-workflows.md).

### Operation Timing

| Operation | Duration |
|-----------|----------|
| Auth token exchange | <1s |
| Project / env / service creation | <1s each |
| Deployment (GitHub source) | 3-7 min |
| Deployment (pre-built image) | 1-2 min |
| Addon: Postgres / Redis | 30-60s / 10-20s |
| Domain verification (BYOD) | 1-30 min (DNS) |
| Domain purchase registration | 1-15 min |
| Env var update | <1s — requires redeploy to take effect |
| Service restart / redeploy | 1-3 min |

## Important: One Project per Codebase

**Each distinct codebase MUST get its own project and environment.** Before creating a service, check whether you already have a project for *this specific codebase*. If yes, reuse it. If no, create a new one — never repurpose a project that was created for a different codebase. Retrying a failed deploy of the same codebase in the same project is fine; deploying a different repo into it is not.

## Billing Pre-flight Check

Before creating services, verify the workspace has sufficient credits. Every service costs $0.25/month, deducted from the credit balance. New workspaces start with $1.00 (covers first 4 services).

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://beta-api.buildwithlocus.com/v1/billing/balance | jq '{creditBalance, totalServices, status}'
```

If `creditBalance` < 0.25, the user must add credits before creating more services. Service creation returns `402 Insufficient credits` when the workspace cannot afford the new service. See [billing.md](./billing.md) for payment flow and credit management.

## Core Workflow: Deploy a Service

### Step 1: Create a Project

Projects group services and environments together.

```bash
PROJECT=$(curl -s -X POST https://beta-api.buildwithlocus.com/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "description": "My application"
  }')

PROJECT_ID=$(echo $PROJECT | jq -r '.id')
echo "Project ID: $PROJECT_ID"
```

To deploy in a non-default region, pass `region` at project creation:

```bash
PROJECT=$(curl -s -X POST https://beta-api.buildwithlocus.com/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "description": "My application",
    "region": "sa-east-1"
  }')
```

| Region | Location | Service URL pattern |
|--------|----------|---------------------|
| `us-east-1` (default) | N. Virginia | `svc-{id}.buildwithlocus.com` |
| `sa-east-1` | Sao Paulo | `svc-{id}.sa.buildwithlocus.com` |

The region is set at project creation and applies to all services in the project. The control plane stays centralized in `us-east-1`; only deployment infrastructure (build, container runtime) runs in the selected region.

Response (201):
```json
{
  "id": "proj_abc123",
  "name": "my-app",
  "description": "My application",
  "region": "us-east-1",
  "workspaceId": "ws_xyz",
  "createdAt": "2026-02-16T00:00:00.000Z"
}
```

### Step 2: Create an Environment

```bash
ENV=$(curl -s -X POST https://beta-api.buildwithlocus.com/v1/projects/$PROJECT_ID/environments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production",
    "type": "production"
  }')

ENV_ID=$(echo $ENV | jq -r '.id')
echo "Environment ID: $ENV_ID"
```

| `type` values | Description |
|---------------|-------------|
| `development` | Local/dev workloads |
| `staging` | Pre-production testing |
| `production` | Live traffic |

Response (201):
```json
{
  "id": "env_def456",
  "name": "production",
  "type": "production",
  "projectId": "proj_abc123"
}
```

### Step 3: Create a Service

Services define what container to run and how. Source can be a pre-built image, a GitHub repo, or pushed via git. Each service costs **$0.25/month** from the workspace credit balance (new accounts start with $1.00). Returns `402` if insufficient credits — see [Billing Pre-flight Check](#billing-pre-flight-check).

> **Pre-built image prerequisites** — every one must be true, or the deploy will fail or hang:
> - **Publicly pullable.** Locus does NOT support private-registry credentials. Private GHCR, Docker Hub private repos, private ECR, and auth-gated registries fail during pull with `403 Forbidden` or `denied`. Make the image public, or use `source.type: "github"` with a `Dockerfile` instead.
> - **Contains a running application.** Bare base images like `node:18-alpine`, `python:3.12-alpine`, `ubuntu:latest` have no HTTP server — they will hang in `deploying` until timeout. These belong in `FROM` lines inside a Dockerfile, not as a service source.
> - **Listens on `PORT=8080`.** The platform injects `PORT=8080` and routes all traffic there. Images defaulting to port 80 (nginx, httpd) or 3000 (Node defaults) fail health checks. For nginx, add `ENV PORT=8080` + `EXPOSE 8080` and use an `envsubst` template that reads `$PORT`.
> - **Responds 200 on the configured health path.** Default `healthCheckPath` is `/`. If you set `/health` but the image only serves `/` (e.g. stock nginx images serve their welcome page at `/` and 404 on `/health`), the service never becomes healthy. Test before deploy: `docker run --rm --platform linux/arm64 -p 8080:8080 -e PORT=8080 <image>` then `curl localhost:8080<healthPath>`.
> - **Built for `linux/arm64`.** Locus runs on AWS Graviton. `exec format error` in logs means the arch is wrong. Build with `docker build --platform linux/arm64`, or use a multi-arch base image.

**Option A — Pre-built image (fastest):**

```bash
SERVICE=$(curl -s -X POST https://beta-api.buildwithlocus.com/v1/services \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "'"$PROJECT_ID"'",
    "environmentId": "'"$ENV_ID"'",
    "name": "web",
    "source": {
      "type": "image",
      "imageUri": "registry.example.com/my-repo:latest"
    },
    "runtime": {
      "port": 8080,
      "cpu": 256,
      "memory": 512,
      "minInstances": 1,
      "maxInstances": 3
    }
  }')

SERVICE_ID=$(echo $SERVICE | jq -r '.id')
echo "Service ID: $SERVICE_ID"
```

**Option B — GitHub repo (builds from source):**

> **Prefer `from-repo`:** If you have a GitHub repo URL, use `POST /v1/projects/from-repo` instead of manually creating project → env → service. It handles everything in one call — auto-detects `.locusbuild` for monorepos, or creates a single `web` service with sensible defaults for repos without one. The manual workflow below is for `git push` (local code) and pre-built images only.

```bash
curl -s -X POST https://beta-api.buildwithlocus.com/v1/services \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "'"$PROJECT_ID"'",
    "environmentId": "'"$ENV_ID"'",
    "name": "web",
    "source": {
      "type": "github",
      "repo": "my-org/my-repo",
      "branch": "main"
    },
    "buildConfig": {
      "method": "dockerfile",
      "dockerfile": "Dockerfile",
      "buildArgs": {"NODE_ENV": "production"}
    },
    "runtime": {
      "port": 8080,
      "cpu": 256,
      "memory": 512
    },
    "autoDeploy": true
  }'
```

**Private repos:** If the repo is private, the user must first connect their GitHub account via the Locus dashboard at **https://beta.buildwithlocus.com/integrations**. Do NOT send users to the raw GitHub App install URL — always direct them to the integrations page. See [git-deploy.md](./git-deploy.md) for the full workflow. Once connected, Locus auto-detects the installation — no extra flags needed.

**Service URL:** The service creation response includes a `url` field — this is the live auto-subdomain URL once deployed:
```json
{
  "id": "svc_abc123",
  "name": "web",
  "url": "https://svc-abc123.buildwithlocus.com",
  ...
}
```
Use this URL to access the service after deployment reaches `healthy` status.

### Choosing a Deploy Method

> **Recommended default:** Add a `.locusbuild` file to your repo and use `from-repo`. One call creates project + env + services + deploy. See [monorepo.md](./monorepo.md) for the file format.

> **Monorepo check before deploy:** If your repo's code lives in subdirectories (e.g. `backend/`, `frontend/`, `services/api/`) rather than at the root, you MUST do one of: (a) add a `.locusbuild` with `services.*.path` per service, (b) set `source.rootDir` per service, or (c) put a `Dockerfile` at the repo root and set `buildConfig.method: "dockerfile"`. Without one of these, the build fails with `Nixpacks was unable to generate a build plan for this app`. Inspect the repo layout before calling `from-repo` or `POST /v1/services`.

| Method | When to use | Source field |
|--------|-------------|-------------|
| **`.locusbuild` + `from-repo`** | You have a GitHub repo (any size). Auto-detects `.locusbuild`, or creates a single `web` service with sensible defaults if absent. | `source.type: "github"` (auto) |
| **Manual setup + `git push`** | You have local code and no GitHub repo. Create project/env/services, then push via git remote. | `source.type: "s3"` with `rootDir` |
| **Pre-built image** | You already have a Docker image in a registry. | `source.type: "image"` with `imageUri` |

> **WARNING:** Do NOT use `from-locusbuild` with a fake/placeholder `repo` — the field must be a real GitHub repository. For local-only code, use manual setup + `git push`.

**Check service runtime status:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://beta-api.buildwithlocus.com/v1/services/$SERVICE_ID?include=runtime"
```

Response includes `runtime_instances`:
```json
{
  "id": "svc_abc123",
  "name": "web",
  "url": "https://svc-abc123.buildwithlocus.com",
  "runtime_instances": {
    "runningCount": 1,
    "desiredCount": 1,
    "pendingCount": 0
  }
}
```

When no container is running yet: `{"runningCount": 0, "desiredCount": 0, "pendingCount": 0, "status": "not_deployed"}`.

> **Note:** `runtime_instances` is cached with a 30-second TTL and may briefly lag behind the actual ECS state. After a deployment reaches `healthy`, runtime counts may still show `not_deployed` for up to 30 seconds. Use deployment status (`healthy`/`failed`) as the primary readiness signal, and `include=runtime` for debugging instance counts.

| Runtime field | Default | Description |
|---------------|---------|-------------|
| `port` | 8080 | Ignored — platform auto-injects PORT=8080. All containers must listen on 8080. |
| `cpu` | 256 | CPU units (256 = 0.25 vCPU) |
| `memory` | 512 | Memory in MB |
| `minInstances` | 1 | Minimum running tasks |
| `maxInstances` | 3 | Maximum running tasks |

| Service field | Default | Description |
|---------------|---------|-------------|
| `startCommand` | *(none — uses image CMD)* | Overrides the container's CMD. Runs as `sh -c "<command>"`. Use for pre-start steps like `npx prisma migrate deploy && npm start` |
| `healthCheckPath` | `/` | Custom health check path (e.g., `/health`, `/healthz`, `/_health`) |
| `errorPatterns` | *(default)* | Custom error patterns for error monitoring (array of strings). Defaults to `ERROR/FATAL/Exception` |

| Build config field | Default | Description |
|--------------------|---------|-------------|
| `method` | `dockerfile` | Build method (`dockerfile`) |
| `dockerfile` | `Dockerfile` | Path to the Dockerfile relative to the service root |
| `buildArgs` | `{}` | Docker build arguments passed as `--build-arg` (e.g., `{"NODE_ENV": "production"}`) |

> **Note:** `buildConfig` fields (`method`, `dockerfile`, `buildArgs`) are only available via the direct `POST /v1/services` API. They cannot be set in a `.locusbuild` file — `.locusbuild` uses Nixpacks auto-detection.
>
> `buildArgs` only apply during **fresh builds** (new deployments from source). A `redeploy` skips the build phase. If you changed build args, push a new commit. See [deployment-workflows.md](./deployment-workflows.md).

**Architecture:** Locus runs on ARM64 (AWS Graviton). Pre-built images must be built for `linux/arm64` (`docker build --platform linux/arm64`). Source builds are handled automatically.

**Health check:** Your container must respond on `/` (root) with HTTP 200 by default. Use `healthCheckPath` to set a different path (e.g., `/health`). Alpine-based images need `apk add --no-cache wget`.

### Step 4: Trigger a Deployment

```bash
DEPLOY=$(curl -s -X POST https://beta-api.buildwithlocus.com/v1/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serviceId": "'"$SERVICE_ID"'"}')

DEPLOYMENT_ID=$(echo $DEPLOY | jq -r '.id')
echo "Deployment ID: $DEPLOYMENT_ID"
```

Response (201):
```json
{
  "id": "deploy_ghi789",
  "serviceId": "svc_xxx",
  "version": 3,
  "status": "queued",
  "source": { "type": "image" },
  "createdAt": "2026-02-16T00:00:00.000Z"
}
```

> **Version** is auto-assigned — monotonically increasing per service, starting at 1. You cannot set it manually.

## Monitor a Deployment

Poll once per tool call until status is terminal. **Don't use a blocking `while true` loop.** Recommended cadence: every 60s (builds take 3-7 min).

```bash
STATUS=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://beta-api.buildwithlocus.com/v1/deployments/$DEPLOYMENT_ID" | jq -r '.status')
echo "$(date +%H:%M:%S) — $STATUS"
# Terminal: healthy | failed | cancelled | rolled_back. Otherwise re-poll in ~60s.
```

| Status | Meaning | Duration |
|--------|---------|----------|
| `queued` | Workflow execution starting | seconds |
| `building` | Cloning + `docker build` (source builds only) | 2-4 min |
| `deploying` | Container starting; health checks running | 1-3 min |
| `healthy` | ECS rollout done + ≥1 task passing health checks (materially ready; brief edge-router delay possible) | terminal |
| `failed` | Deployment failed — check logs | terminal |
| `cancelled` | User cancelled | terminal |
| `rolled_back` | Replaced by a rollback deployment | terminal |

Image deployments (`source.type=image`) skip `building`.

**`GET /v1/deployments/:id`** also returns `durationMs` and (on failure) `lastLogs[]` (last 20 lines). For deeper timing analysis (`metadata.phaseTimestamps`), lifecycle endpoints (cancel/rollback/restart/redeploy), and when to check logs, see [deployment-workflows.md](./deployment-workflows.md).

## Environment Variables

> **Addon variables require explicit references.** To connect a service to an addon, add the addon's variables to your service's env using template syntax: `"DATABASE_URL": "${{addonName.DATABASE_URL}}"`. Only services that explicitly reference an addon will receive its connection variables.

Variables are set per-service. They are injected as environment variables into the container at deploy time.

**Set all variables (replaces existing):**

```bash
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"LOCUS_API_KEY": "claw_...", "LOG_LEVEL": "info"}}' \
  "https://beta-api.buildwithlocus.com/v1/variables/service/$SERVICE_ID"
```

**Merge variables (adds/updates, keeps others):**

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"variables": {"NEW_KEY": "value"}}' \
  "https://beta-api.buildwithlocus.com/v1/variables/service/$SERVICE_ID"
```

**Get resolved variables** (includes addon connection strings and auto-injected sibling service URLs):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://beta-api.buildwithlocus.com/v1/variables/service/$SERVICE_ID/resolved"
```

Response shape:

```json
{
  "variables": {
    "LOCUS_SERVICE_URL": "https://svc-abc123.buildwithlocus.com",
    "API_URL": "https://svc-def456.buildwithlocus.com"
  }
}
```

After setting variables, trigger a new deployment for them to take effect.

## Service-to-Service References

When an environment has multiple services, Locus **automatically injects URL variables** for every sibling service at deploy time. No manual wiring or linking is needed.

### Auto-injected Variables

For each sibling service in the same environment, these variables are injected:

| Variable | Value | Use case |
|----------|-------|----------|
| `{SERVICE_NAME}_URL` | `https://svc-{id}.buildwithlocus.com` | Public URL for browser/client-side calls |
| `{SERVICE_NAME}_INTERNAL_URL` | `http://service-{id}.locus.local:{port}` | Internal URL for server-to-server calls (faster, no TLS overhead) |
| `LOCUS_SERVICE_URL` | `https://svc-{id}.buildwithlocus.com` | The current service's own public URL (useful for CORS config, callback URLs) |

The service name is uppercased with non-alphanumeric characters replaced by underscores. For example, a service named `api` produces `API_URL` and `API_INTERNAL_URL`.

### Template Syntax

You can also reference sibling services in variable templates:

```
${{api.URL}}           → https://svc-xxx.buildwithlocus.com
${{api.INTERNAL_URL}}  → http://service-svc_xxx.locus.local:8080
${{api.PORT}}          → 8080
```

> **Resolution timing:** Templates are resolved at deployment time — not when you set the variable. Use `GET /v1/variables/service/:id/resolved` to preview resolved values. Addon templates (e.g., `${{db.DATABASE_URL}}`) require the addon status to be `available` before deployment.

### Template Reference

For the full template syntax (sibling-service templates and addon templates), see [monorepo.md](./monorepo.md) (`.locusbuild` env blocks) and [addons.md](./addons.md) (addon-specific templates like `${{addonName.DATABASE_URL}}`).

## Project Configuration (`.locusbuild`)

A `.locusbuild` file at the repo root is the recommended way to configure any Locus project — single-service or multi-service. It defines services, addons, environment variables, and build settings in a version-controlled file Locus auto-detects. For format, setup, and examples, see [monorepo.md](./monorepo.md).

## Access Deployed Services

Every deployed service gets an **auto-subdomain**, with `{id}` = the service ID with underscores replaced by hyphens (e.g. `svc_abc123` → `svc-abc123`):

| Region | URL pattern |
|--------|-------------|
| `us-east-1` | `https://svc-{id}.buildwithlocus.com` |
| `sa-east-1` | `https://svc-{id}.sa.buildwithlocus.com` |

Supports HTTPS, WebSockets (`wss://`), and all HTTP methods. The edge router forwards `Upgrade`/`Connection` headers with a 24-hour timeout — no config needed.

> **⚠️ Service Discovery Delay:** After `healthy`, the public URL may 503 for **up to 60 seconds** while the container registers with service discovery. Normal, not a bug. Tell the user to expect a brief delay.

## Response Format

Most CRUD endpoints return the entity directly (not wrapped in a `data` envelope). Lists use plural keys: `{projects: [...]}`, `{services: [...]}`, etc. Errors are usually `{"error": "..."}` with optional `details`.

Aggregate and helper endpoints can return named objects or wrappers. Examples:
- `POST /v1/projects/from-repo` returns `{ project, environment, services, deployments, ... }`
- `POST /v1/projects/from-locusbuild` returns the same aggregate shape
- `GET /v1/variables/service/:id/resolved` returns `{ variables: { ... } }`

When a deployment object is returned directly, use `.id`. Some aggregate responses also include `.deploymentId` for compatibility.

HTTP status codes: 200 (ok), 201 (created), 204 (deleted), 400 (bad request), 401 (bad/expired token), 404 (not found), 500 (server error).

## Companion Guides

These guides cover features beyond the core deploy path. Load them on-demand when needed.

| Guide | When to use |
|-------|-------------|
| [onboarding.md](./onboarding.md) | First-time setup: wallet detection, auth, billing webhooks |
| [agent-quickstart.md](./agent-quickstart.md) | Copy-paste deploy scripts, SSE status streaming, error recovery |
| [billing.md](./billing.md) | Credit balance, payments, 402 handling, delinquency |
| [deployment-workflows.md](./deployment-workflows.md) | Deployment timing, agent monitoring workflow, lifecycle endpoints |
| [monorepo.md](./monorepo.md) | `.locusbuild` file format, from-repo setup, verification, auto-detection |
| [logs.md](./logs.md) | Stream or search logs, logging best practices |
| [webhooks.md](./webhooks.md) | Set up webhooks for deployment events, error alerts, log streaming |
| [addons.md](./addons.md) | Provision Postgres/Redis, run queries, execute migrations |
| [domains.md](./domains.md) | Add custom domains (BYOD or purchase) |
| [git-deploy.md](./git-deploy.md) | Git push deploy, GitHub App integration, auto-deploy |
| [api-reference.md](./api-reference.md) | Complete table of all 80+ API endpoints |
| [troubleshooting.md](./troubleshooting.md) | Platform architecture, common issues |
| [checkout.md](./checkout.md) | USDC payments with `@withlocus/checkout-react` SDK |
