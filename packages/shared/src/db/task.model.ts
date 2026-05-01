// `tasks` — escrow-flow task records. User pays escrow → agent does work
// → escrow released to agent OR refunded to user.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const TASK_STATUSES = [
  "DRAFT",
  "PAID",
  "DISPATCHED",
  "PROCESSING",
  "DELIVERED",
  "RELEASED",
  "FAILED",
  "REFUNDED",
  "EXPIRED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ESCROW_SESSION_STATUSES = [
  "PENDING",
  "PAID",
  "EXPIRED",
  "CANCELLED",
] as const;
export type EscrowSessionStatus = (typeof ESCROW_SESSION_STATUSES)[number];

const taskSchema = new Schema(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    userIdentifier: { type: String, required: true },
    agentId: { type: String, required: true, index: true },
    input: { type: String, required: true },
    pricingUsdc: { type: Number, required: true, min: 0 },

    escrowSessionId: { type: String, required: true, unique: true, index: true },
    /** Persisted at session-create time so the frontend can mount the
     *  Locus Checkout iframe against the correct beta/prod origin.
     *  Locus's GET /sessions/:id omits this field, so we have to keep
     *  the value we got back at create. */
    escrowCheckoutUrl: { type: String, default: null },
    escrowSessionStatus: {
      type: String,
      enum: ESCROW_SESSION_STATUSES,
      required: true,
      default: "PENDING",
    },
    escrowTxHash: { type: String, default: null },
    escrowReleaseTxHash: { type: String, default: null },
    escrowRefundTxHash: { type: String, default: null },
    payerWalletAddress: { type: String, default: null },

    status: {
      type: String,
      enum: TASK_STATUSES,
      required: true,
      default: "DRAFT",
    },

    output: { type: String, default: null },
    outputAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    verificationNotes: { type: String, default: null },
    modelUsed: { type: String, default: null },

    borrowedToFulfill: { type: Boolean, required: true, default: false },
    loanId: { type: String, default: null },

    dispatchAttempts: { type: Number, required: true, default: 0, min: 0 },
    lastDispatchError: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "tasks",
  },
);

taskSchema.index({ agentId: 1, status: 1 });
taskSchema.index({ createdAt: -1 });

export type Task = InferSchemaType<typeof taskSchema>;
export const TaskModel: Model<Task> = model<Task>("Task", taskSchema);
