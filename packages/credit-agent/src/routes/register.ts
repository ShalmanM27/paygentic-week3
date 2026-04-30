// POST /credit/register — upsert a borrower with cold-start defaults.

import type { FastifyInstance } from "fastify";
import { BorrowerModel } from "@credit/shared";

const bodySchema = {
  type: "object",
  required: ["borrowerId", "walletAddress", "serviceUrl", "registrationApiKey"],
  additionalProperties: false,
  properties: {
    borrowerId: { type: "string", minLength: 1 },
    walletAddress: { type: "string", minLength: 1 },
    serviceUrl: { type: "string", minLength: 1 },
    registrationApiKey: { type: "string", minLength: 8 },
  },
} as const;

interface RegisterBody {
  borrowerId: string;
  walletAddress: string;
  serviceUrl: string;
  registrationApiKey: string;
}

export async function registerRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterBody }>(
    "/credit/register",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { borrowerId, walletAddress, serviceUrl, registrationApiKey } =
        req.body;
      const wallet = walletAddress.toLowerCase();
      try {
        const updated = await BorrowerModel.findOneAndUpdate(
          { borrowerId },
          {
            $set: {
              walletAddress: wallet,
              serviceUrl,
              apiKey: registrationApiKey,
            },
            $setOnInsert: {
              borrowerId,
              status: "ACTIVE",
              score: 500,
              limit: 0,
              outstanding: 0,
              defaultCount: 0,
              registeredAt: new Date(),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        if (!updated) {
          return reply
            .code(500)
            .send({ error: "registration_failed", reason: "no_doc" });
        }
        req.log.info(
          {
            borrowerId,
            wallet,
            apiKeyPrefix: registrationApiKey.slice(0, 8),
          },
          "borrower registered",
        );
        return {
          ok: true,
          score: updated.score,
          limit: updated.limit,
        };
      } catch (err) {
        req.log.error({ err }, "register failed");
        return reply
          .code(500)
          .send({ error: "registration_failed", reason: String(err) });
      }
    },
  );
}
