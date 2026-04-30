// `transactions` — flat ledger of every money movement we observe.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const TRANSACTION_TYPES = [
  "draw",
  "repayment",
  "score_sale",
  "default_writeoff",
  "borrower_revenue",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ["PENDING", "CONFIRMED", "FAILED"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const transactionSchema = new Schema(
  {
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    borrowerId: { type: String, default: null },
    amount: { type: Number, required: true, min: 0 },
    sessionId: { type: String, default: null },
    txHash: { type: String, default: null },
    locusTransactionId: { type: String, default: null },
    status: {
      type: String,
      enum: TRANSACTION_STATUSES,
      required: true,
      default: "PENDING",
    },
    loanId: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "transactions" },
);

transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ borrowerId: 1, createdAt: -1 });

export type Transaction = InferSchemaType<typeof transactionSchema>;
export const TransactionModel: Model<Transaction> =
  model<Transaction>("Transaction", transactionSchema);
