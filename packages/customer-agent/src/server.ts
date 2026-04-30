// Fastify factory for the customer agent. /healthz + /trigger only.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLocusClient, type LocusClientLike } from "@credit/shared";
import type { CustomerAgentConfig } from "./lib/config.js";
import { triggerRoute } from "./routes/trigger.js";

export interface BuildCustomerResult {
  app: FastifyInstance;
  locus: LocusClientLike;
}

export async function buildServer(
  config: CustomerAgentConfig,
): Promise<BuildCustomerResult> {
  const app = Fastify({
    logger: {
      level: "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss" },
            },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
    credentials: false,
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request error");
    if (err.validation) {
      return reply.code(400).send({
        error: "validation_failed",
        details: err.validation,
      });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.code(status).send({
      error: err.code ?? "internal_error",
      message: err.message,
    });
  });

  const locus = createLocusClient({
    apiKey: config.locusApiKey,
    apiBase: config.locusApiBase,
    offline: config.locusOfflineMode,
    mockBalance: config.mockBalance,
  });

  app.get("/healthz", async () => ({ ok: true }));
  await triggerRoute(app, config, locus);

  return { app, locus };
}
