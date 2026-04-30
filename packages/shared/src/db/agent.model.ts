// `agents` — DB-backed marketplace registry. Built-ins (summarizer, code-
// reviewer, code-writer) are seeded with isBuiltIn=true and don't pay rent.
// Operator-registered agents start inactive; subscription-watcher flips
// isActive=true once the rent session settles PAID.

import { Schema, model, type InferSchemaType, type Model } from "mongoose";

export const AGENT_CATEGORIES = [
  "Text",
  "Engineering",
  "Creative",
  "Research",
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

const agentSchema = new Schema(
  {
    agentId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true },
    description: { type: String, required: true },
    category: { type: String, enum: AGENT_CATEGORIES, required: true },
    emoji: { type: String, required: true },
    pricingUsdc: { type: Number, required: true, min: 0 },

    operatorId: { type: String, required: true, index: true },
    operatorName: { type: String, required: true },
    operatorEmail: { type: String, default: null },

    serviceUrl: { type: String, required: true },
    capabilities: { type: [String], required: true, default: [] },
    walletAddress: { type: String, required: true },

    /** Built-ins are seeded permanently active; never charged rent. */
    isBuiltIn: { type: Boolean, required: true, default: false },
    /** Listed on /agents/registry only when true. */
    isActive: { type: Boolean, required: true, default: false, index: true },
    activatedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "agents",
  },
);

export type Agent = InferSchemaType<typeof agentSchema>;
export const AgentModel: Model<Agent> = model<Agent>("Agent", agentSchema);
