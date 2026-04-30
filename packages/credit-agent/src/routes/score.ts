// GET /score?wallet=0x... — free thin score summary.

import type { FastifyInstance } from "fastify";
import { BorrowerModel, LoanModel } from "@credit/shared";

const WALLET_RE = /^0x[0-9a-f]{40}$/;

function tierFor(score: number): string {
  if (score >= 800) return "PRIME";
  if (score >= 700) return "GOOD";
  if (score >= 600) return "FAIR";
  if (score >= 500) return "SUBPRIME";
  return "BLOCKED";
}

export async function scoreRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { wallet?: string } }>(
    "/score",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["wallet"],
          properties: { wallet: { type: "string", minLength: 42, maxLength: 42 } },
        },
      },
    },
    async (req, reply) => {
      const wallet = (req.query.wallet ?? "").toLowerCase();
      if (!WALLET_RE.test(wallet)) {
        return reply
          .code(400)
          .send({ error: "invalid_wallet", expected: "0x + 40 hex" });
      }
      const borrower = await BorrowerModel.findOne({ walletAddress: wallet });
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }
      const openLoans = await LoanModel.countDocuments({
        borrowerId: borrower.borrowerId,
        status: "FUNDED",
      });
      return {
        score: borrower.score,
        tier: tierFor(borrower.score),
        openLoans,
        defaultCount: borrower.defaultCount,
        lastUpdate:
          (borrower as unknown as { updatedAt?: Date }).updatedAt?.toISOString() ??
          borrower.registeredAt?.toISOString() ??
          null,
      };
    },
  );
}
