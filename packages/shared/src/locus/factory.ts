// Canonical entry-point for obtaining a Locus client. Every service uses
// this; nobody calls `new LocusClient()` directly. Honors LOCUS_OFFLINE_MODE
// from the environment unless `offline` is passed explicitly.

import { LocusClient } from "./client.js";
import { MockLocusClient } from "./mock-client.js";

export interface CreateLocusClientOptions {
  apiKey: string;
  apiBase?: string;
  /** Override env-driven offline mode. */
  offline?: boolean;
  /** Forwarded to MockLocusClient when offline=true. */
  mockBalance?: string;
}

export type LocusClientLike = LocusClient | MockLocusClient;

export function createLocusClient(
  opts: CreateLocusClientOptions,
): LocusClientLike {
  const offline =
    opts.offline ?? process.env.LOCUS_OFFLINE_MODE === "1";
  if (offline) {
    return new MockLocusClient({
      apiKey: opts.apiKey,
      mockBalance: opts.mockBalance,
    });
  }
  return new LocusClient({ apiKey: opts.apiKey, apiBase: opts.apiBase });
}
