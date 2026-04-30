// POST /work — create a Locus session, return 402 with the discovery payload.
// Job context (url, callbackUrl) is remembered keyed by sessionId.
//
// Triggering processJob: in beta, Locus does not fire webhooks. Instead we
// kick off a background `waitForSessionSettled` poll on the session we just
// created — when the customer pays, the borrower runs processJob. The
// /webhooks handler remains as defense-in-depth for when Locus ships
// webhook delivery; processJob is idempotent (jobStore clears on completion).

import type { FastifyInstance } from "fastify";
import type { LocusClientLike } from "@credit/shared";
import type { BorrowerConfig } from "../server.js";
import { rememberJob } from "../lib/job-store.js";
import { processJob } from "../lib/process-job.js";
import type { CreditClient } from "../lib/credit-client.js";

const bodySchema = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1 },
    callbackUrl: { type: "string", minLength: 1 },
  },
} as const;

interface WorkBody {
  url: string;
  callbackUrl?: string;
}

export async function workRoute(
  app: FastifyInstance,
  config: BorrowerConfig,
  locus: LocusClientLike,
  credit: CreditClient,
): Promise<void> {
  app.post<{ Body: WorkBody }>(
    "/work",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { url, callbackUrl } = req.body;
      const session = await locus.createSession({
        amount: String(config.workPrice),
        currency: "USDC",
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: config.borrowerId,
            lineItems: [
              { description: `Scrape ${url}`, amount: String(config.workPrice) },
            ],
          },
        },
        metadata: {
          kind: "borrower-work",
          borrowerId: config.borrowerId,
          url,
        },
        ttlSeconds: 600,
      });
      rememberJob({
        sessionId: session.id,
        url,
        callbackUrl: callbackUrl ?? "",
        amount: config.workPrice,
        createdAt: new Date(),
      });
      req.log.info(
        { sessionId: session.id, url },
        "work: session created (402)",
      );

      // Background: poll the session until paid, then run processJob.
      // Fire-and-forget. processJob is idempotent if a webhook also fires.
      const log = req.log;
      void (async () => {
        try {
          const settled = await locus.waitForSessionSettled(session.id, 600_000);
          const upper = String(settled.status).toUpperCase();
          if (upper === "PAID") {
            log.info(
              { sessionId: session.id },
              "work: customer paid — running processJob",
            );
            await processJob(session.id, { config, locus, credit, log });
          } else {
            log.warn(
              { sessionId: session.id, status: settled.status },
              "work: session reached non-PAID terminal — skipping processJob",
            );
          }
        } catch (err) {
          log.warn(
            {
              sessionId: session.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "work: background settle watcher errored",
          );
        }
      })();

      return reply.code(402).send({
        sessionId: session.id,
        checkoutUrl: session.checkoutUrl ?? null,
        amount: config.workPrice,
        currency: "USDC",
        lineItems: [
          { description: `Scrape ${url}`, amount: String(config.workPrice) },
        ],
      });
    },
  );
}
