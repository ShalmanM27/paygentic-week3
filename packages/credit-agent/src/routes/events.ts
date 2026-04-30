// GET /events — SSE stream subscribed to the in-process sseBus.
// IMPORTANT: this route uses reply.hijack() to write SSE frames directly,
// which bypasses Fastify's reply lifecycle — including @fastify/cors.
// We therefore set Access-Control-Allow-Origin manually on writeHead.

import type { FastifyInstance } from "fastify";
import type { CreditAgentConfig } from "../lib/config.js";
import { recentEvents, subscribe } from "../lib/sse-bus.js";

export async function eventsRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  app.get("/events", (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": config.frontendOrigin,
      "access-control-allow-credentials": "false",
      vary: "origin",
    });
    raw.write(": connected\n\n");

    // Replay recent events to catch the new subscriber up.
    for (const e of recentEvents()) {
      raw.write(`data: ${JSON.stringify(e)}\n\n`);
    }

    const unsubscribe = subscribe((e) => {
      try {
        raw.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch {
        unsubscribe();
      }
    });

    req.raw.on("close", () => {
      unsubscribe();
      try {
        raw.end();
      } catch {
        /* already ended */
      }
    });
  });
}
