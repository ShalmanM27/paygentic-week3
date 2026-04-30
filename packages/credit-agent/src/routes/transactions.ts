// GET /transactions — paginated ledger with type + borrower filters.

import type { FastifyInstance } from "fastify";
import { TransactionModel, TRANSACTION_TYPES } from "@credit/shared";

interface Q {
  type?: string;
  borrowerId?: string;
  limit?: number;
  offset?: number;
}

const querystring = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...TRANSACTION_TYPES] },
    borrowerId: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

export async function transactionsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Q }>(
    "/transactions",
    { schema: { querystring } },
    async (req) => {
      const limit = req.query.limit ?? 20;
      const offset = req.query.offset ?? 0;

      const filter: Record<string, unknown> = {};
      if (req.query.type) filter.type = req.query.type;
      if (req.query.borrowerId) filter.borrowerId = req.query.borrowerId;

      const [total, rows] = await Promise.all([
        TransactionModel.countDocuments(filter),
        TransactionModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean(),
      ]);

      return {
        transactions: rows.map((r) => ({
          _id: String(r._id),
          type: r.type,
          borrowerId: r.borrowerId,
          amount: r.amount,
          sessionId: r.sessionId,
          txHash: r.txHash,
          locusTransactionId: r.locusTransactionId,
          status: r.status,
          loanId: r.loanId,
          createdAt: r.createdAt,
        })),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + rows.length < total,
        },
      };
    },
  );
}
