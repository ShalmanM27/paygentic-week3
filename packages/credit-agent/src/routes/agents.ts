// GET /agents/:borrowerId         — full borrower profile + recent loans
// GET /agents/:borrowerId/balance  — proxy for Locus balance() (5s cache)

import type { FastifyInstance } from "fastify";
import {
  BorrowerModel,
  LoanModel,
  ScoreEventModel,
  createLocusClient,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";

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
}

export function _resetAgentsCache(): void {
  balanceCache.clear();
}
