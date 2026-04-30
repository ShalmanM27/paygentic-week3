// GET /.well-known/locus-credit.json — discovery manifest for borrowers.

import type { FastifyInstance } from "fastify";
import type { CreditAgentConfig } from "../lib/config.js";

const MIN_SCORE_FOR_LOAN = 500;

export async function wellKnownRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  app.get("/.well-known/locus-credit.json", async () => ({
    creditAgent: config.publicBaseUrl,
    endpoints: {
      register: "POST /credit/register",
      draw: "POST /credit/draw",
      fund: "POST /credit/fund",
      score: "GET  /score?wallet=0x...",
      report: "POST /score-report",
    },
    terms: {
      minScore: MIN_SCORE_FOR_LOAN,
      minLoanUsdc: config.minLoanUsdc,
      maxLoanUsdc: config.maxLoanUsdc,
      maxTtlSeconds: config.maxTtlSeconds,
    },
  }));
}
