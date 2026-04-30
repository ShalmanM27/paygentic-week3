// POST /credit/draw — issue a 60s HMAC-signed decisionToken. No money moves.

import type { FastifyInstance } from "fastify";
import { BorrowerModel, rateFor, repayAmount } from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { sign as signDecision } from "../lib/decision-token.js";

const TOKEN_TTL_SECONDS = 60;

interface DrawBody {
  borrowerId: string;
  amount: number;
  purpose: string;
  ttl: number;
}

export async function drawRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  const bodySchema = {
    type: "object",
    required: ["borrowerId", "amount", "purpose", "ttl"],
    additionalProperties: false,
    properties: {
      borrowerId: { type: "string", minLength: 1 },
      amount: {
        type: "number",
        exclusiveMinimum: 0,
        maximum: config.maxLoanUsdc,
      },
      purpose: { type: "string", minLength: 1 },
      ttl: {
        type: "integer",
        minimum: 60,
        maximum: config.maxTtlSeconds,
      },
    },
  };

  app.post<{ Body: DrawBody }>(
    "/credit/draw",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { borrowerId, amount, purpose, ttl } = req.body;

      if (amount < config.minLoanUsdc) {
        return reply.code(400).send({
          approved: false,
          reason: "below_min_loan",
          minLoanUsdc: config.minLoanUsdc,
        });
      }

      const borrower = await BorrowerModel.findOne({ borrowerId });
      if (!borrower) {
        return reply.code(404).send({ approved: false, reason: "borrower_not_found" });
      }
      if (borrower.status !== "ACTIVE") {
        return reply
          .code(403)
          .send({
            approved: false,
            reason: `borrower_status:${borrower.status}`,
          });
      }

      const available = borrower.limit - borrower.outstanding;
      if (amount > available) {
        return reply.code(403).send({
          approved: false,
          reason: "insufficient_credit_limit",
          limit: borrower.limit,
          outstanding: borrower.outstanding,
        });
      }

      const rate = rateFor(borrower.score);
      if (rate >= 0.99) {
        return reply
          .code(403)
          .send({ approved: false, reason: "score_too_low", score: borrower.score });
      }

      const repay = repayAmount(amount, rate, ttl);
      const now = Date.now();
      const expiresAt = new Date(now + TOKEN_TTL_SECONDS * 1000).toISOString();
      const dueAt = new Date(now + ttl * 1000).toISOString();

      const decisionToken = signDecision(
        { borrowerId, amount, rate, ttlSeconds: ttl, expiresAt },
        config.decisionTokenSecret,
      );

      req.log.info(
        { borrowerId, amount, rate, purpose },
        "draw approved",
      );

      return {
        approved: true,
        decisionToken,
        amount,
        rate,
        repayAmount: repay,
        expiresAt,
        dueAt,
      };
    },
  );
}
