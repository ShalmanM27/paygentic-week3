// `borrowers` — one row per registered borrower agent.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const BORROWER_STATUSES = ["ACTIVE", "DEFAULTED", "SUSPENDED"] as const;
export type BorrowerStatus = (typeof BORROWER_STATUSES)[number];

const borrowerSchema = new Schema(
  {
    borrowerId: { type: String, required: true, unique: true, index: true },
    // NOT unique — multiple agents can share a Locus wallet (one party
    // hosts many agents). Indexed for query speed only.
    walletAddress: { type: String, required: true, index: true },
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

// Virtual `agentId` — same value as `borrowerId`. The DB schema field stays
// `borrowerId` for stability across the X1 rename; surfaces (frontend, API
// responses where appropriate) prefer `agentId`. To include in lean()
// queries: pass `{ virtuals: true }`.
borrowerSchema.virtual("agentId").get(function () {
  return (this as unknown as { borrowerId: string }).borrowerId;
});
borrowerSchema.set("toJSON", { virtuals: true });
borrowerSchema.set("toObject", { virtuals: true });

export type Borrower = InferSchemaType<typeof borrowerSchema>;
export const BorrowerModel: Model<Borrower> =
  model<Borrower>("Borrower", borrowerSchema);
