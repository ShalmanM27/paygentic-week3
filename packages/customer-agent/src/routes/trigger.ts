// POST /trigger — buy one job from the named borrower. Demo control surface.

import type { FastifyInstance } from "fastify";
import type { LocusClientLike } from "@credit/shared";
import type { CustomerAgentConfig } from "../lib/config.js";
import { trigger, type BorrowerId } from "../lib/trigger.js";

const bodySchema = {
  type: "object",
  required: ["borrowerId"],
  additionalProperties: false,
  properties: {
    borrowerId: { type: "string", enum: ["agent-a", "agent-b"] },
    url: { type: "string", minLength: 1 },
  },
} as const;

interface TriggerBody {
  borrowerId: BorrowerId;
  url?: string;
}

export async function triggerRoute(
  app: FastifyInstance,
  config: CustomerAgentConfig,
  locus: LocusClientLike,
): Promise<void> {
  app.post<{ Body: TriggerBody }>(
    "/trigger",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      try {
        const result = await trigger(
          { config, locus, log: req.log },
          { borrowerId: req.body.borrowerId, url: req.body.url },
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.warn({ err: message }, "trigger failed");
        return reply.code(502).send({ error: "trigger_failed", message });
      }
    },
  );
}
