// Fastify app factory. Wires routes, captures rawBody for webhooks,
// installs a JSON-only error handler, runs an SSE heartbeat.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { CreditAgentConfig } from "./lib/config.js";
import { seedBuiltInAgents } from "./lib/agent-registry.js";
import { agentsRoute } from "./routes/agents.js";
import { debugRoute } from "./routes/debug.js";
import { drawRoute } from "./routes/draw.js";
import { eventsRoute } from "./routes/events.js";
import { fundRoute } from "./routes/fund.js";
import { loansRoute } from "./routes/loans.js";
import { registerRoute } from "./routes/register.js";
import { scoreRoute } from "./routes/score.js";
import { scoreEventsRoute } from "./routes/score-events.js";
import { scoreReportRoute } from "./routes/score-report.js";
import { statsRoute } from "./routes/stats.js";
import { tasksRoute } from "./routes/tasks.js";
import { transactionsRoute } from "./routes/transactions.js";
import { webhooksRoute } from "./routes/webhooks.js";
import { wellKnownRoute } from "./routes/well-known.js";
import { publish } from "./lib/sse-bus.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function buildServer(
  config: CreditAgentConfig,
): Promise<FastifyInstance> {
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
    disableRequestLogging: false,
  });

  await app.register(cors, {
    origin: config.frontendOrigin || "http://localhost:3000",
    credentials: false,
    exposedHeaders: ["content-type"],
  });

  // Capture raw JSON body globally — needed for webhook HMAC verification.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const text = body as string;
      try {
        const json = text.length === 0 ? {} : JSON.parse(text);
        req.rawBody = text;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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

  app.get("/healthz", async () => ({
    ok: true,
    offline: config.locusOfflineMode,
    locusMode: config.locusOfflineMode ? "offline/mock" : "live/beta",
  }));

  // Seed built-in marketplace agents on boot. Idempotent — won't insert
  // a row if one already exists for the same agentId.
  try {
    const seedResult = await seedBuiltInAgents();
    if (seedResult.seeded.length > 0) {
      app.log.info(
        { seeded: seedResult.seeded },
        "agent-registry: seeded built-in agents",
      );
    }
  } catch (err) {
    app.log.error({ err }, "agent-registry: seed failed (non-fatal)");
  }

  await wellKnownRoute(app, config);
  await registerRoute(app);
  await drawRoute(app, config);
  await fundRoute(app, config);
  await webhooksRoute(app, config);
  await scoreRoute(app);
  await scoreReportRoute(app, config);
  await scoreEventsRoute(app);
  await transactionsRoute(app);
  await agentsRoute(app, config);
  await statsRoute(app);
  await loansRoute(app);
  await tasksRoute(app, config);
  await eventsRoute(app, config);
  await debugRoute(app, config);

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    publish({
      kind: "system.heartbeat",
      ts: Date.now(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive solely for the heartbeat.
  heartbeat.unref?.();
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
  });

  return app;
}
