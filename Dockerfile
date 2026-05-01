# Universal monorepo image for the CREDIT services.
#
# One image, six services. Each Locus service points at this same
# Dockerfile and overrides the CMD via the per-service `startCommand`
# field (e.g. `pnpm --filter @credit/borrower start`). Locus's build
# script only honours a file literally named "Dockerfile" at the build
# root — that's why this is generalised and not per-service.
#
# Targets linux/arm64 (Locus AWS Graviton). The base image is
# multi-arch so local amd64 builds still work.
#
# Locus injects PORT=8080 and routes traffic there. Each service's
# config already reads `process.env.PORT ?? "<localdefault>"`, so binding
# to 8080 in production happens automatically.

# ── Stage 1: install all workspace deps ──────────────────────────────
FROM node:20-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# Copy workspace manifest + every package.json so pnpm can resolve the
# graph without copying source yet (better Docker layer caching).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/credit-agent/package.json packages/credit-agent/
COPY packages/borrower/package.json packages/borrower/
COPY packages/customer-agent/package.json packages/customer-agent/
COPY packages/agent-summarizer/package.json packages/agent-summarizer/
COPY packages/agent-code-reviewer/package.json packages/agent-code-reviewer/
COPY packages/agent-code-writer/package.json packages/agent-code-writer/
COPY apps/frontend/package.json apps/frontend/

RUN pnpm install --frozen-lockfile --prefer-offline

# ── Stage 2: copy source + slim runtime ──────────────────────────────
FROM node:20-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# wget for Locus default health checks if needed.
RUN apk add --no-cache wget

WORKDIR /app

# Bring in the resolved root node_modules from the deps stage. Each
# package's nested node_modules is restored too so workspace symlinks
# (`@credit/shared` etc.) keep resolving at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/credit-agent/node_modules ./packages/credit-agent/node_modules
COPY --from=deps /app/packages/borrower/node_modules ./packages/borrower/node_modules
COPY --from=deps /app/packages/customer-agent/node_modules ./packages/customer-agent/node_modules
COPY --from=deps /app/packages/agent-summarizer/node_modules ./packages/agent-summarizer/node_modules
COPY --from=deps /app/packages/agent-code-reviewer/node_modules ./packages/agent-code-reviewer/node_modules
COPY --from=deps /app/packages/agent-code-writer/node_modules ./packages/agent-code-writer/node_modules
COPY --from=deps /app/apps/frontend/node_modules ./apps/frontend/node_modules

# Workspace metadata.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Source for every workspace package — same image, different CMD per
# service.
COPY packages/shared/ packages/shared/
COPY packages/credit-agent/ packages/credit-agent/
COPY packages/borrower/ packages/borrower/
COPY packages/customer-agent/ packages/customer-agent/
COPY packages/agent-summarizer/ packages/agent-summarizer/
COPY packages/agent-code-reviewer/ packages/agent-code-reviewer/
COPY packages/agent-code-writer/ packages/agent-code-writer/
COPY apps/frontend/ apps/frontend/

ENV NODE_ENV=production
EXPOSE 8080

# Default CMD = credit-agent. Other services override via Locus
# `startCommand` (e.g. `pnpm --filter @credit/borrower start`).
CMD ["pnpm", "--filter", "@credit/credit-agent", "start"]
