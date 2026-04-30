// `agent_subscriptions` — one record per rent payment. Subscription-watcher
// polls Locus for the escrow session; on PAID, flips status=ACTIVE and
// activates the linked agent.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const SUBSCRIPTION_STATUSES = [
  "PENDING_PAYMENT",
  "ACTIVE",
  "EXPIRED",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_SESSION_STATUSES = [
  "PENDING",
  "PAID",
  "EXPIRED",
  "CANCELLED",
] as const;
export type SubscriptionSessionStatus =
  (typeof SUBSCRIPTION_SESSION_STATUSES)[number];

const subscriptionSchema = new Schema(
  {
    subscriptionId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },
    operatorId: { type: String, required: true },
    rentUsdc: { type: Number, required: true, min: 0 },

    coverageStartAt: { type: Date, default: null },
    coverageEndAt: { type: Date, default: null },

    escrowSessionId: { type: String, required: true, unique: true },
    escrowSessionStatus: {
      type: String,
      enum: SUBSCRIPTION_SESSION_STATUSES,
      required: true,
      default: "PENDING",
    },
    escrowTxHash: { type: String, default: null },

    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      required: true,
      default: "PENDING_PAYMENT",
    },
  },
  {
    timestamps: true,
    collection: "agent_subscriptions",
  },
);

subscriptionSchema.index({ agentId: 1, coverageEndAt: -1 });

export type AgentSubscription = InferSchemaType<typeof subscriptionSchema>;
export const AgentSubscriptionModel: Model<AgentSubscription> =
  model<AgentSubscription>("AgentSubscription", subscriptionSchema);
