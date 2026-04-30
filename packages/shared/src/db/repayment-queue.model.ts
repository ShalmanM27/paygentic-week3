// `repayment_queue` — collection-loop work items, one per outstanding loan.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const REPAYMENT_STATES = [
  "WAITING",
  "ATTEMPTING",
  "ATTEMPTING_SETTLED",
  "COMPLETED",
  "FAILED",
] as const;
export type RepaymentState = (typeof REPAYMENT_STATES)[number];

const repaymentQueueSchema = new Schema(
  {
    loanId: { type: String, required: true, unique: true, index: true },
    borrowerId: { type: String, required: true },
    repaymentSessionId: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, default: 4, min: 1 },
    nextAttemptAt: { type: Date, required: true, default: () => new Date() },
    state: {
      type: String,
      enum: REPAYMENT_STATES,
      required: true,
      default: "WAITING",
    },
    lastError: { type: String, default: null },
    /**
     * Borrower wallet usdc_balance snapshot taken just before agentPay.
     * Used by settlement-watcher to confirm an on-chain drop when the
     * webhook doesn't arrive (or polling endpoints are unusable).
     */
    preAmountSnapshot: { type: Number, default: null },
    locusTransactionId: { type: String, default: null },
    settlementAttemptedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "repayment_queue",
  },
);

repaymentQueueSchema.index({ state: 1, nextAttemptAt: 1 });

export type RepaymentQueueItem = InferSchemaType<typeof repaymentQueueSchema>;
export const RepaymentQueueModel: Model<RepaymentQueueItem> = model<RepaymentQueueItem>(
  "RepaymentQueueItem",
  repaymentQueueSchema,
);
