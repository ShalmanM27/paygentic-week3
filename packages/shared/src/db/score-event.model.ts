// `score_events` — append-only log of score-affecting facts.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const SCORE_EVENT_TYPES = [
  "session_paid",
  "session_refunded",
  "session_expired",
  "loan_repaid",
  "loan_defaulted",
  "score_recomputed",
] as const;
export type ScoreEventType = (typeof SCORE_EVENT_TYPES)[number];

export const SCORE_EVENT_SOURCES = ["webhook", "loop", "manual"] as const;
export type ScoreEventSource = (typeof SCORE_EVENT_SOURCES)[number];

const scoreEventSchema = new Schema(
  {
    borrowerId: { type: String, required: true },
    type: { type: String, enum: SCORE_EVENT_TYPES, required: true },
    delta: { type: Number, required: true },
    reason: { type: String, required: true },
    source: { type: String, enum: SCORE_EVENT_SOURCES, required: true },
    payload: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "score_events" },
);

scoreEventSchema.index({ borrowerId: 1, createdAt: -1 });

export type ScoreEvent = InferSchemaType<typeof scoreEventSchema>;
export const ScoreEventModel: Model<ScoreEvent> =
  model<ScoreEvent>("ScoreEvent", scoreEventSchema);
