// GET /score/:wallet/events — recent score_events for a borrower.

import type { FastifyInstance } from "fastify";
import { BorrowerModel, ScoreEventModel } from "@credit/shared";

const WALLET_RE = /^0x[0-9a-f]{40}$/i;

interface Params {
  wallet: string;
}
interface Q {
  limit?: number;
}

export async function scoreEventsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params; Querystring: Q }>(
    "/score/:wallet/events",
    {
      schema: {
        params: {
          type: "object",
          required: ["wallet"],
          properties: {
            wallet: { type: "string", minLength: 42, maxLength: 42 },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const wallet = req.params.wallet.toLowerCase();
      if (!WALLET_RE.test(wallet)) {
        return reply.code(400).send({ error: "invalid_wallet" });
      }
      const borrower = await BorrowerModel.findOne({ walletAddress: wallet }).lean();
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }
      const limit = req.query.limit ?? 20;
      const events = await ScoreEventModel.find({
        borrowerId: borrower.borrowerId,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return {
        wallet,
        borrowerId: borrower.borrowerId,
        events: events.map((e) => ({
          type: e.type,
          delta: e.delta,
          reason: e.reason,
          source: e.source,
          createdAt: (e as unknown as { createdAt?: Date }).createdAt ?? null,
        })),
      };
    },
  );
}
