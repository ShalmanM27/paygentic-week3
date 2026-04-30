// GET /loans/:loanId/sessions — the three Locus sessions for a loan.
// Statuses are derived from loan state (no Locus calls). Customer session
// is not currently threaded through to the loan record — returned null.

import type { FastifyInstance } from "fastify";
import { LoanModel } from "@credit/shared";

interface Params {
  loanId: string;
}

function disbursementStatus(loan: {
  disbursementStatus?: string | null;
  disbursementTxHash?: string | null;
}): string {
  if (loan.disbursementStatus) return loan.disbursementStatus;
  return loan.disbursementTxHash ? "PAID" : "PENDING";
}

function repaymentStatus(loan: {
  status: string;
  repaymentTxHash?: string | null;
}): string {
  if (loan.status === "REPAID") return "PAID";
  if (loan.status === "DEFAULTED") return "FAILED";
  return loan.repaymentTxHash ? "PAID" : "PENDING";
}

export async function loansRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params }>(
    "/loans/:loanId/sessions",
    {
      schema: {
        params: {
          type: "object",
          required: ["loanId"],
          properties: { loanId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      const { loanId } = req.params;
      const loan = await LoanModel.findOne({ loanId }).lean();
      if (!loan) {
        return reply.code(404).send({ error: "loan_not_found" });
      }
      return {
        loanId: loan.loanId,
        disbursement: loan.targetSessionId
          ? {
              sessionId: loan.targetSessionId,
              status: disbursementStatus(loan),
              txHash: loan.disbursementTxHash ?? null,
            }
          : null,
        repayment: loan.repaymentSessionId
          ? {
              sessionId: loan.repaymentSessionId,
              status: repaymentStatus(loan),
              txHash: loan.repaymentTxHash ?? null,
            }
          : null,
        // TODO(production): thread the customer's /work session through
        // process-job.ts so we can surface it here. Currently null.
        customer: null,
      };
    },
  );
}
