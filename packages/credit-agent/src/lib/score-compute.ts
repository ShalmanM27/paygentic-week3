// Deterministic score computation. Reused by /score-report/result and the
// score-recompute loop.
//
// score = 500
//        + 30 * delivery_success_rate
//        - 25 * refund_rate
//        + 50 * repayment_punctuality
//        - 80 * default_count
//        + 10 * log(1 + lifetime_repaid)
//        - 5  * open_loan_count
//
// Clamped to [300, 850].

import {
  BorrowerModel,
  LoanModel,
  ScoreEventModel,
} from "@credit/shared";

export interface ScoreComponents {
  deliverySuccessRate: number;
  refundRate: number;
  repaymentPunctuality: number;
  defaultCount: number;
  lifetimeRepaid: number;
  openLoanCount: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponents;
}

const FLOOR = 300;
const CEIL = 850;

export async function computeScore(borrowerId: string): Promise<ScoreResult> {
  const borrower = await BorrowerModel.findOne({ borrowerId });
  const defaultCount = borrower?.defaultCount ?? 0;

  const events = await ScoreEventModel.find({ borrowerId });
  const repaid = events.filter((e) => e.type === "loan_repaid");
  const defaulted = events.filter((e) => e.type === "loan_defaulted");
  const totalTerminal = repaid.length + defaulted.length;
  const repaymentPunctuality =
    totalTerminal > 0 ? repaid.length / totalTerminal : 1;

  const lifetimeRepaid = repaid.reduce((sum, e) => {
    const amt = (e.payload as { amount?: number } | null)?.amount;
    return sum + (typeof amt === "number" ? amt : 0);
  }, 0);

  const openLoanCount = await LoanModel.countDocuments({
    borrowerId,
    status: "FUNDED",
  });

  // TODO: wire deliverySuccessRate when borrower-side webhooks land.
  const deliverySuccessRate = 1;
  const refundRate = 0;

  const raw =
    500 +
    30 * deliverySuccessRate -
    25 * refundRate +
    50 * repaymentPunctuality -
    80 * defaultCount +
    10 * Math.log(1 + lifetimeRepaid) -
    5 * openLoanCount;

  const score = Math.max(FLOOR, Math.min(CEIL, Math.round(raw)));

  return {
    score,
    components: {
      deliverySuccessRate,
      refundRate,
      repaymentPunctuality,
      defaultCount,
      lifetimeRepaid,
      openLoanCount,
    },
  };
}
