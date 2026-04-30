// Mongoose connection helper. Each service calls connect(uri) once at boot.

import mongoose from "mongoose";

let connectPromise: Promise<typeof mongoose> | null = null;

export async function connect(uri: string): Promise<typeof mongoose> {
  if (connectPromise) return connectPromise;
  mongoose.set("strictQuery", true);
  connectPromise = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
  return connectPromise;
}

export async function disconnect(): Promise<void> {
  await mongoose.disconnect();
  connectPromise = null;
}

export { mongoose };
