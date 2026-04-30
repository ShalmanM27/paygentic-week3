// `loans` — one row per draw/fund cycle.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const LOAN_STATUSES = [
  "REQUESTED",
  "FUNDED",
  "REPAID",
  "DEFAULTED",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

const loanSchema = new Schema(
  {
    loanId: { type: String, required: true, unique: true, index: true },
    borrowerId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    interestRate: { type: Number, required: true, min: 0 },
    repayAmount: { type: Number, required: true, min: 0 },
    purpose: { type: String, required: true },
    decisionToken: { type: String, required: true },
    targetSessionId: { type: String, default: null },
    disbursementTransactionId: { type: String, default: null },
    disbursementStatus: { type: String, default: null },
    disbursementTxHash: { type: String, default: null },
    repaymentSessionId: { type: String, default: null },
    repaymentTxHash: { type: String, default: null },
    /** When this loan was funded to cover an escrow task, the task's id. */
    linkedTaskId: { type: String, default: null },
    status: {
      type: String,
      enum: LOAN_STATUSES,
      required: true,
      default: "REQUESTED",
    },
    createdAt: { type: Date, required: true, default: () => new Date() },
    fundedAt: { type: Date, default: null },
    dueAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
  },
  { collection: "loans" },
);

loanSchema.index({ borrowerId: 1, status: 1 });
loanSchema.index({ linkedTaskId: 1 }, { sparse: true });

export type Loan = InferSchemaType<typeof loanSchema>;
export const LoanModel: Model<Loan> = model<Loan>("Loan", loanSchema);
