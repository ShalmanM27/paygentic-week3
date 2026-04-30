// GET  /agents/:borrowerId           — full borrower profile + recent loans
// GET  /agents/:borrowerId/balance   — proxy for Locus balance() (5s cache)
// POST /agents/register              — operator submits a new agent + rent session
// GET  /agents/:agentId/subscription — latest subscription record (any status)

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  AgentModel,
  AgentSubscriptionModel,
  BorrowerModel,
  LoanModel,
  ScoreEventModel,
  createLocusClient,
  nextSubscriptionId,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { getLocusClient } from "../lib/locus.js";
import { publish } from "../lib/sse-bus.js";

const BALANCE_TTL_MS = 5_000;
const balanceCache = new Map<
  string,
  { fetchedAt: number; payload: unknown }
>();

interface Params {
  borrowerId: string;
}

export async function agentsRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  // ── /agents/:borrowerId ─────────────────────────────────────────────
  app.get<{ Params: Params }>(
    "/agents/:borrowerId",
    {
      schema: {
        params: {
          type: "object",
          required: ["borrowerId"],
          properties: { borrowerId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { borrowerId } = req.params;
      const borrower = await BorrowerModel.findOne({ borrowerId }).lean();
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }

      const recentLoans = await LoanModel.find({ borrowerId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

      // Lifetime totals from score_events + loans.
      const events = await ScoreEventModel.find({ borrowerId }).lean();
      const lifetimeRepaidAmt = events
        .filter((e) => e.type === "loan_repaid")
        .reduce((s, e) => {
          const v = (e.payload as { amount?: number } | null)?.amount;
          return s + (typeof v === "number" ? v : 0);
        }, 0);
      const lifetimeBorrowed = recentLoans
        .filter((l) => l.status !== "REQUESTED")
        .reduce((s, l) => s + l.amount, 0);
      const lifetimeDefaultedAmt = events
        .filter((e) => e.type === "loan_defaulted")
        .reduce((s, e) => {
          const v = (e.payload as { amount?: number } | null)?.amount;
          return s + (typeof v === "number" ? v : 0);
        }, 0);
      const openLoanCount = await LoanModel.countDocuments({
        borrowerId,
        status: "FUNDED",
      });

      return {
        borrower: {
          borrowerId: borrower.borrowerId,
          walletAddress: borrower.walletAddress,
          status: borrower.status,
          score: borrower.score,
          limit: borrower.limit,
          outstanding: borrower.outstanding,
          defaultCount: borrower.defaultCount,
          registeredAt: borrower.registeredAt,
          updatedAt: (borrower as unknown as { updatedAt?: Date }).updatedAt ?? null,
          serviceUrl: borrower.serviceUrl,
          apiKeyPrefix:
            typeof borrower.apiKey === "string"
              ? borrower.apiKey.slice(0, 12)
              : null,
        },
        recentLoans,
        totals: {
          lifetimeBorrowed,
          lifetimeRepaid: lifetimeRepaidAmt,
          lifetimeDefaulted: lifetimeDefaultedAmt,
          openLoanCount,
        },
      };
    },
  );

  // ── /agents/:borrowerId/balance ─────────────────────────────────────
  app.get<{ Params: Params; Querystring: { force?: string } }>(
    "/agents/:borrowerId/balance",
    async (req, reply) => {
      const { borrowerId } = req.params;
      const force = req.query.force === "1";

      const cached = balanceCache.get(borrowerId);
      if (
        !force &&
        cached &&
        Date.now() - cached.fetchedAt < BALANCE_TTL_MS
      ) {
        return { ...(cached.payload as object), cached: true };
      }

      const borrower = await BorrowerModel.findOne({ borrowerId }).lean();
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }

      const locus = createLocusClient({
        apiKey: borrower.apiKey,
        apiBase: config.locusApiBase,
        offline: config.locusOfflineMode,
        mockBalance: config.mockBalance,
      });
      const bal = await locus.balance();

      const payload = {
        borrowerId,
        walletAddress: bal.wallet_address,
        usdcBalance: Number(bal.usdc_balance),
        promoBalance: Number(bal.promo_credit_balance),
        chain: bal.chain,
        fetchedAt: new Date().toISOString(),
      };
      balanceCache.set(borrowerId, { fetchedAt: Date.now(), payload });
      return { ...payload, cached: false };
    },
  );

  // ── POST /agents/register ──────────────────────────────────────────────
  // Operator registers a new agent; we mint a rent session and persist
  // both the Agent (isActive=false) + AgentSubscription (PENDING_PAYMENT).
  // The subscription-watcher activates the agent once the session settles.
  const AGENT_ID_RE = /^[a-z]+(-[a-z]+)*$/;
  const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
  const SERVICE_URL_RE = /^https?:\/\/.+/;

  const registerBodySchema = {
    type: "object",
    required: [
      "agentId",
      "displayName",
      "description",
      "category",
      "emoji",
      "pricingUsdc",
      "operatorName",
      "operatorEmail",
      "serviceUrl",
      "walletAddress",
      "capabilities",
    ],
    additionalProperties: false,
    properties: {
      agentId: { type: "string", minLength: 2, maxLength: 60 },
      displayName: { type: "string", minLength: 2, maxLength: 60 },
      description: { type: "string", minLength: 5, maxLength: 280 },
      category: {
        type: "string",
        enum: ["Text", "Engineering", "Creative", "Research"],
      },
      emoji: { type: "string", minLength: 1, maxLength: 8 },
      pricingUsdc: { type: "number", minimum: 0.001, maximum: 1.0 },
      operatorName: { type: "string", minLength: 1, maxLength: 80 },
      operatorEmail: { type: "string", minLength: 3, maxLength: 200 },
      serviceUrl: { type: "string", minLength: 1, maxLength: 500 },
      walletAddress: { type: "string", minLength: 10, maxLength: 80 },
      capabilities: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  } as const;

  interface RegisterBody {
    agentId: string;
    displayName: string;
    description: string;
    category: "Text" | "Engineering" | "Creative" | "Research";
    emoji: string;
    pricingUsdc: number;
    operatorName: string;
    operatorEmail: string;
    serviceUrl: string;
    walletAddress: string;
    capabilities: string[];
  }

  app.post<{ Body: RegisterBody }>(
    "/agents/register",
    { schema: { body: registerBodySchema } },
    async (req, reply) => {
      const body = req.body;
      if (!AGENT_ID_RE.test(body.agentId)) {
        return reply
          .code(400)
          .send({ error: "invalid_agent_id", hint: "lowercase-with-hyphens" });
      }
      if (!WALLET_RE.test(body.walletAddress)) {
        return reply
          .code(400)
          .send({ error: "invalid_wallet_address", hint: "0x + 40 hex chars" });
      }
      if (!SERVICE_URL_RE.test(body.serviceUrl)) {
        return reply
          .code(400)
          .send({ error: "invalid_service_url", hint: "http(s)://…" });
      }

      const existing = await AgentModel.findOne({ agentId: body.agentId }).lean();
      if (existing) {
        return reply.code(409).send({ error: "agent_id_taken" });
      }

      // Deterministic operatorId from email — repeat registrations from the
      // same operator share an id.
      const operatorId =
        "op-" +
        createHash("sha256")
          .update(body.operatorEmail.toLowerCase().trim())
          .digest("hex")
          .slice(0, 8);

      const subscriptionId = await nextSubscriptionId();
      const rent = config.agentRentUsdc;

      const locus = getLocusClient();
      const session = await locus.createSession({
        amount: rent.toFixed(4),
        currency: "USDC",
        ttlSeconds: 1800,
        metadata: {
          subscriptionId,
          agentId: body.agentId,
          type: "rent",
        },
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: "CREDIT — Agent Hosting Rent",
            lineItems: [
              {
                description: `Monthly hosting for ${body.displayName}`,
                amount: rent.toFixed(4),
              },
            ],
          },
        },
      });

      const agentDoc = await AgentModel.create({
        agentId: body.agentId,
        displayName: body.displayName,
        description: body.description,
        category: body.category,
        emoji: body.emoji,
        pricingUsdc: body.pricingUsdc,
        operatorId,
        operatorName: body.operatorName,
        operatorEmail: body.operatorEmail,
        serviceUrl: body.serviceUrl,
        walletAddress: body.walletAddress,
        capabilities: body.capabilities,
        isBuiltIn: false,
        isActive: false,
      });

      const subDoc = await AgentSubscriptionModel.create({
        subscriptionId,
        agentId: body.agentId,
        operatorId,
        rentUsdc: rent,
        escrowSessionId: session.id,
        escrowSessionStatus: "PENDING",
        status: "PENDING_PAYMENT",
      });

      publish({
        kind: "agent.registered",
        ts: Date.now(),
        agentId: body.agentId,
        operatorId,
        subscriptionId,
      });

      req.log.info(
        { agentId: body.agentId, subscriptionId, operatorId },
        "agent registered (pending rent payment)",
      );

      return {
        agent: agentDoc.toObject(),
        subscription: subDoc.toObject(),
        checkoutUrl: session.checkoutUrl,
        sessionId: session.id,
      };
    },
  );

  // ── GET /agents/:agentId/subscription ──────────────────────────────────
  // Latest subscription, regardless of status. Used by /add-agent/[id].
  app.get<{ Params: { agentId: string } }>(
    "/agents/:agentId/subscription",
    async (req, reply) => {
      const sub = await AgentSubscriptionModel.findOne({
        agentId: req.params.agentId,
      })
        .sort({ createdAt: -1 })
        .lean();
      if (!sub) {
        return reply.code(404).send({ error: "no_subscription" });
      }
      const agent = await AgentModel.findOne({ agentId: req.params.agentId }).lean();
      return { subscription: sub, agent };
    },
  );

  // ── GET /subscriptions/:subscriptionId ─────────────────────────────────
  // Companion endpoint indexed by subscription id (used by post-submission
  // page where we know the sub id but not the agent id yet).
  app.get<{ Params: { subscriptionId: string } }>(
    "/subscriptions/:subscriptionId",
    async (req, reply) => {
      const sub = await AgentSubscriptionModel.findOne({
        subscriptionId: req.params.subscriptionId,
      }).lean();
      if (!sub) {
        return reply.code(404).send({ error: "subscription_not_found" });
      }
      const agent = await AgentModel.findOne({ agentId: sub.agentId }).lean();
      return { subscription: sub, agent };
    },
  );
}

export function _resetAgentsCache(): void {
  balanceCache.clear();
}
