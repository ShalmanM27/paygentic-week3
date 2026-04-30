// `borrowers` — one row per registered borrower agent.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const BORROWER_STATUSES = ["ACTIVE", "DEFAULTED", "SUSPENDED"] as const;
export type BorrowerStatus = (typeof BORROWER_STATUSES)[number];

const borrowerSchema = new Schema(
  {
    borrowerId: { type: String, required: true, unique: true, index: true },
    walletAddress: { type: String, required: true, unique: true, index: true },
    apiKey: { type: String, required: true },
    serviceUrl: { type: String, required: true },
    status: {
      type: String,
      enum: BORROWER_STATUSES,
      required: true,
      default: "ACTIVE",
    },
    score: { type: Number, required: true, default: 500, min: 300, max: 850 },
    limit: { type: Number, required: true, default: 0, min: 0 },
    outstanding: { type: Number, required: true, default: 0, min: 0 },
    defaultCount: { type: Number, required: true, default: 0, min: 0 },
    registeredAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: false, updatedAt: "updatedAt" }, collection: "borrowers" },
);

export type Borrower = InferSchemaType<typeof borrowerSchema>;
export const BorrowerModel: Model<Borrower> =
  model<Borrower>("Borrower", borrowerSchema);
