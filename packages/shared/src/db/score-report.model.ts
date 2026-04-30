// `score_reports` — paid full credit reports purchased via Locus checkout.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const SCORE_REPORT_STATUSES = [
  "PENDING",
  "CLAIMABLE",
  "DELIVERED",
] as const;
export type ScoreReportStatus = (typeof SCORE_REPORT_STATUSES)[number];

const scoreReportSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    wallet: { type: String, required: true },
    status: {
      type: String,
      enum: SCORE_REPORT_STATUSES,
      required: true,
      default: "PENDING",
    },
    amount: { type: Number, required: true, min: 0 },
    txHash: { type: String, default: null },
    paidAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    snapshotScore: { type: Number, default: null },
    snapshotTier: { type: String, default: null },
    snapshotComponents: { type: Schema.Types.Mixed, default: null },
    snapshotEvents: { type: [Schema.Types.Mixed], default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "score_reports" },
);

scoreReportSchema.index({ wallet: 1, createdAt: -1 });

export type ScoreReport = InferSchemaType<typeof scoreReportSchema>;
export const ScoreReportModel: Model<ScoreReport> = model<ScoreReport>(
  "ScoreReport",
  scoreReportSchema,
);
