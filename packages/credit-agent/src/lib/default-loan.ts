// Shared default-handling. Called from collection-loop (max attempts) and
// default-loop (due-date passed). Idempotent on repeated calls.

import {
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  ScoreEventModel,
  TransactionModel,
} from "@credit/shared";
import { publish } from "./sse-bus.js";

const defaultedCache = new Set<string>();

export function defaultedBorrowers(): string[] {
  return [...defaultedCache];
}

export async function defaultLoan(args: {
  loanId: string;
  reason: "max_attempts_reached" | "due_date_passed";
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): Promise<void> {
  const loan = await LoanModel.findOne({ loanId: args.loanId });
  if (!loan) {
    args.log.warn({ loanId: args.loanId }, "defaultLoan: loan missing");
    return;
  }
  if (loan.status === "DEFAULTED" || loan.status === "REPAID") {
    args.log.info(
      { loanId: loan.loanId, status: loan.status },
      "defaultLoan: terminal already, skipping",
    );
    return;
  }

  const now = new Date();
  loan.status = "DEFAULTED";
  loan.closedAt = now;
  await loan.save();

  await BorrowerModel.updateOne({ borrowerId: loan.borrowerId }, [
    {
      $set: {
        defaultCount: { $add: ["$defaultCount", 1] },
        outstanding: {
          $max: [0, { $subtract: ["$outstanding", loan.repayAmount] }],
        },
      },
    },
  ]);

  await ScoreEventModel.create({
    borrowerId: loan.borrowerId,
    type: "loan_defaulted",
    delta: -80,
    reason: `default on ${loan.loanId} (${args.reason})`,
    source: "loop",
    payload: {
      loanId: loan.loanId,
      amount: loan.repayAmount,
      reason: args.reason,
    },
    createdAt: now,
  });

  await TransactionModel.create({
    type: "default_writeoff",
    borrowerId: loan.borrowerId,
    amount: loan.repayAmount,
    sessionId: loan.repaymentSessionId,
    txHash: null,
    locusTransactionId: null,
    status: "CONFIRMED",
    loanId: loan.loanId,
    createdAt: now,
  });

  await RepaymentQueueModel.updateMany(
    {
      loanId: loan.loanId,
      state: { $in: ["WAITING", "ATTEMPTING", "ATTEMPTING_SETTLED"] },
    },
    { $set: { state: "FAILED", lastError: `defaulted: ${args.reason}` } },
  );

  defaultedCache.add(loan.borrowerId);

  publish({
    kind: "loan.defaulted",
    ts: Date.now(),
    loanId: loan.loanId,
    borrowerId: loan.borrowerId,
    reason: args.reason,
    linkedTaskId: loan.linkedTaskId ?? null,
  });

  args.log.info(
    { loanId: loan.loanId, borrowerId: loan.borrowerId, reason: args.reason },
    "loan defaulted",
  );
}

export function _resetDefaultedCache(): void {
  defaultedCache.clear();
}
