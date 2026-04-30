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

// Accepts either `input` (new agent-task shape) or `url` (legacy customer-
// agent's /trigger which still sends `url` as the input string). One of the
// two is required.
const bodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    input: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    callbackUrl: { type: "string", minLength: 1 },
  },
  oneOf: [{ required: ["input"] }, { required: ["url"] }],
} as const;

interface WorkBody {
  input?: string;
  url?: string;
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
      const userInput = req.body.input ?? req.body.url ?? "";
      const callbackUrl = req.body.callbackUrl;
      const description = `${config.agentName} task`;
      const session = await locus.createSession({
        amount: String(config.workPrice),
        currency: "USDC",
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: config.agentName,
            lineItems: [
              { description, amount: String(config.workPrice) },
            ],
          },
        },
        metadata: {
          kind: "agent-work",
          agentId: config.agentId,
          inputPreview: userInput.slice(0, 80),
        },
        ttlSeconds: 600,
      });
      rememberJob({
        sessionId: session.id,
        input: userInput,
        callbackUrl: callbackUrl ?? "",
        amount: config.workPrice,
        createdAt: new Date(),
      });
      req.log.info(
        { sessionId: session.id, agentId: config.agentId },
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
        agentId: config.agentId,
        agentName: config.agentName,
        lineItems: [{ description, amount: String(config.workPrice) }],
      });
    },
  );
}
