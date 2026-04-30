// Atomic counters keyed by name. Used for monotonic IDs (taskId, etc.).

import { Schema, model, type Model } from "mongoose";

interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "counters" },
);

export const CounterModel: Model<CounterDoc> = model<CounterDoc>(
  "Counter",
  counterSchema,
);

/** Atomic increment-and-get. Upserts the counter doc on first call. */
export async function nextSeq(name: string): Promise<number> {
  const doc = await CounterModel.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc?.seq ?? 1;
}

export async function nextTaskId(): Promise<string> {
  const seq = await nextSeq("taskId");
  return `T_${seq.toString().padStart(4, "0")}`;
}

export async function nextSubscriptionId(): Promise<string> {
  const seq = await nextSeq("subscriptionId");
  return `S_${seq.toString().padStart(4, "0")}`;
}
