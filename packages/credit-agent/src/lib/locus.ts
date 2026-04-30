// Server-singleton Locus client. Built once at boot from config; routes import this.

import {
  createLocusClient,
  type LocusClientLike,
} from "@credit/shared";
import type { CreditAgentConfig } from "./config.js";

let client: LocusClientLike | null = null;

export function initLocusClient(config: CreditAgentConfig): LocusClientLike {
  client = createLocusClient({
    apiKey: config.locusApiKey,
    apiBase: config.locusApiBase,
    offline: config.locusOfflineMode,
    mockBalance: config.mockBalance,
  });
  return client;
}

export function getLocusClient(): LocusClientLike {
  if (!client) throw new Error("locus client not initialised");
  return client;
}
