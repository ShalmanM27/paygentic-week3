// POST /credit/fund — preflight + agentPay against borrower's target session,
// then create the repayment session and persist loan + queue + transaction.

import type { FastifyInstance } from "fastify";
import {
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  TransactionModel,
  repayAmount as computeRepay,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { verify as verifyDecision } from "../lib/decision-token.js";
import { mintLoanId } from "../lib/loan-id.js";
import { getLocusClient } from "../lib/locus.js";
import { publish } from "../lib/sse-bus.js";

const AMOUNT_TOLERANCE = 0.0005;

const bodySchema = {
  type: "object",
  required: ["decisionToken", "targetSessionId"],
  additionalProperties: false,
  properties: {
    decisionToken: { type: "string", minLength: 1 },
    targetSessionId: { type: "string", minLength: 1 },
  },
} as const;

interface FundBody {
  decisionToken: string;
  targetSessionId: string;
}

export async function fundRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  app.post<{ Body: FundBody }>(
    "/credit/fund",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { decisionToken, targetSessionId } = req.body;
      const verified = verifyDecision(decisionToken, config.decisionTokenSecret);
      if (!verified.ok) {
        return reply
          .code(400)
          .send({ error: "decision_token_invalid", reason: verified.reason });
      }
      const { borrowerId, amount, rate, ttlSeconds } = verified.payload;

      const borrower = await BorrowerModel.findOne({ borrowerId });
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }
      if (borrower.status !== "ACTIVE") {
        return reply
          .code(403)
          .send({ error: "borrower_not_active", status: borrower.status });
      }

      const locus = getLocusClient();

      // 1. Preflight the target session.
      const pre = await locus.preflight(targetSessionId);
      if (!pre.canPay) {
        return reply
          .code(400)
          .send({ error: "preflight_failed", blockers: pre.blockers ?? [] });
      }
      const sessionAmount = Number(pre.session.amount);
      if (Math.abs(sessionAmount - amount) > AMOUNT_TOLERANCE) {
        return reply.code(400).send({
          error: "amount_mismatch",
          expected: amount,
          got: sessionAmount,
        });
      }

      // 2. Pay the target session as the credit agent.
      // Locus team confirmed (2026-04-30): /checkout/agent/payments/:id
      // is broken in beta and webhooks aren't implemented. Canonical
      // confirmation = poll /checkout/sessions/:id until PAID, which
      // includes paymentTxHash on the PAID response.
      const pay = await locus.agentPay(targetSessionId);
      const transactionId = pay.transactionId;
      const payStatusUpper = String(pay.status).toUpperCase();
      const ACCEPTABLE_INFLIGHT = new Set(["QUEUED", "PROCESSING", "CONFIRMED"]);
      if (!ACCEPTABLE_INFLIGHT.has(payStatusUpper)) {
        return reply
          .code(502)
          .send({ error: "disbursement_rejected", status: pay.status });
      }

      // Wait for settlement via getSession polling.
      let txHash: string | null = null;
      let disbursementStatusFinal = "PENDING_CONFIRMATION";
      try {
        const settled = await locus.waitForSessionSettled(targetSessionId, 30_000);
        const settledUpper = String(settled.status).toUpperCase();
        if (settledUpper === "PAID") {
          txHash = settled.paymentTxHash ?? null;
          disbursementStatusFinal = "CONFIRMED";
        } else {
          // EXPIRED / CANCELLED — unexpected; we just paid it. Don't 502
          // since money likely moved; flag as UNKNOWN for the frontend.
          disbursementStatusFinal = "UNKNOWN";
          req.log.warn(
            { targetSessionId, settledStatus: settled.status },
            "fund: target session settled to non-PAID terminal status",
          );
        }
      } catch (err) {
        disbursementStatusFinal = "UNKNOWN";
        req.log.warn(
          { targetSessionId, err: err instanceof Error ? err.message : String(err) },
          "fund: waitForSessionSettled timed out — money likely moved, confirmation unknown",
        );
      }

      // 3. Mint loan id and create the repayment session (Credit as merchant).
      const loanId = await mintLoanId();
      const repayAmt = computeRepay(amount, rate, ttlSeconds);
      const ratePct = (rate * 100).toFixed(0);
      const description = `Repayment of ${loanId} (${ttlSeconds}s @ ${ratePct}% APR)`;

      const repaySession = await locus.createSession({
        amount: String(repayAmt),
        currency: "USDC",
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: "CREDIT",
            lineItems: [{ description, amount: String(repayAmt) }],
          },
        },
        metadata: { loanId, borrowerId, kind: "repayment" },
        ttlSeconds,
      });
      const repaymentSessionId = repaySession.id;

      // 4. Persist loan, queue item, transaction.
      const now = new Date();
      const dueAt = new Date(now.getTime() + ttlSeconds * 1000);

      await LoanModel.create({
        loanId,
        borrowerId,
        amount,
        interestRate: rate,
        repayAmount: repayAmt,
        purpose: "wrapped-api/firecrawl-scrape",
        decisionToken,
        targetSessionId,
        disbursementTransactionId: transactionId,
        disbursementStatus: disbursementStatusFinal,
        disbursementTxHash: txHash,
        repaymentSessionId,
        repaymentTxHash: null,
        status: "FUNDED",
        createdAt: now,
        fundedAt: now,
        dueAt,
        closedAt: null,
      });

      await RepaymentQueueModel.create({
        loanId,
        borrowerId,
        repaymentSessionId,
        amount: repayAmt,
        attempts: 0,
        maxAttempts: config.maxRepaymentAttempts,
        nextAttemptAt: new Date(
          now.getTime() + config.repaymentFirstAttemptDelaySeconds * 1000,
        ),
        state: "WAITING",
        lastError: null,
      });

      await TransactionModel.create({
        type: "draw",
        borrowerId,
        amount,
        sessionId: targetSessionId,
        txHash,
        locusTransactionId: transactionId,
        status: disbursementStatusFinal === "CONFIRMED" ? "CONFIRMED" : "PENDING",
        loanId,
        createdAt: now,
      });

      borrower.outstanding += repayAmt;
      await borrower.save();

      publish({
        kind: "loan.funded",
        ts: Date.now(),
        loanId,
        borrowerId,
        amount,
        repayAmount: repayAmt,
        dueAt: dueAt.toISOString(),
        txHash,
        targetSessionId,
        repaymentSessionId,
      });

      req.log.info({ loanId, borrowerId, amount, repayAmt }, "loan funded");

      return {
        loanId,
        disbursement: {
          transactionId,
          txHash,
          status: disbursementStatusFinal,
        },
        repaymentSessionId,
        repayAmount: repayAmt,
        dueAt: dueAt.toISOString(),
      };
    },
  );
}

