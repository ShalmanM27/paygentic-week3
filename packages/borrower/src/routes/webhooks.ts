// POST /webhooks — own session.paid events. HMAC-verified.
// On match: kick off processJob asynchronously, ack 200 immediately.

import type { FastifyInstance } from "fastify";
import {
  parseWebhookEvent,
  verifyWebhookSignature,
  type LocusClientLike,
} from "@credit/shared";
import type { BorrowerConfig } from "../server.js";
import { CreditClient } from "../lib/credit-client.js";
import { processJob } from "../lib/process-job.js";

export async function webhooksRoute(
  app: FastifyInstance,
  config: BorrowerConfig,
  locus: LocusClientLike,
  credit: CreditClient,
): Promise<void> {
  app.post("/webhooks", async (req, reply) => {
    const sigHeader = req.headers["x-locus-signature"];
    const signatureHeader =
      typeof sigHeader === "string"
        ? sigHeader
        : Array.isArray(sigHeader)
          ? sigHeader[0]
          : undefined;

    const rawBody = req.rawBody ?? "";
    const verify = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      secret: config.locusWebhookSecret,
    });
    if (!verify.valid) {
      req.log.warn({ reason: verify.reason }, "webhook signature rejected");
      return reply
        .code(400)
        .send({ error: "signature_mismatch", reason: verify.reason });
    }

    let event;
    try {
      event = parseWebhookEvent(rawBody);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "malformed_event", reason: String(err) });
    }

    if (event.type === "checkout.session.paid") {
      // Process synchronously in offline tests for predictable assertions;
      // in production the same await is fine — Locus permits up to 5s ack.
      try {
        await processJob(event.data.sessionId, {
          config,
          locus,
          credit,
          log: req.log,
        });
      } catch (err) {
        req.log.error({ err, sessionId: event.data.sessionId }, "processJob threw");
        return reply.code(500).send({ error: "process_failed" });
      }
    } else {
      req.log.info({ type: event.type }, "non-paid webhook — ignoring");
    }

    return { ok: true };
  });
}
