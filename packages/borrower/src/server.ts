// Fastify factory for a borrower service. Wires /work, /webhooks, /healthz.
// Captures rawBody for HMAC verification.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLocusClient, type LocusClientLike } from "@credit/shared";
import { CreditClient } from "./lib/credit-client.js";
import { workRoute } from "./routes/work.js";
import { workWithInputRoute } from "./routes/work-with-input.js";
import { webhooksRoute } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface BorrowerConfig {
  port: number;
  /** Stable identifier (was borrowerId pre-X1). Sent as `borrowerId` over
   *  the wire to credit-agent for DB compatibility. */
  agentId: string;
  /** Display name surfaced to customers. */
  agentName: string;
  /** One-line marketing description. */
  agentDescription: string;
  /** Gemini model id used by do-work for LLM calls. */
  geminiModel: string;
  /** Google AI Studio API key (free tier). Required in live mode only;
   *  ignored when locusOfflineMode=true. */
  geminiApiKey: string;
  /** Base URL for Google AI Studio's generative API. */
  geminiApiBase: string;
  /** Role-specific system prompt prepended to every LLM call. */
  systemPrompt: string;
  locusApiKey: string;
  locusApiBase: string;
  locusWebhookSecret: string;
  locusOfflineMode: boolean;
  mockBalance?: string;
  workPrice: number;
  workCost: number;
  safetyBuffer: number;
  creditAgentUrl: string;
}

export interface BuildBorrowerResult {
  app: FastifyInstance;
  locus: LocusClientLike;
  credit: CreditClient;
}

export async function buildBorrowerServer(
  config: BorrowerConfig,
): Promise<BuildBorrowerResult> {
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

  // CORS — frontend (port 3000) hits each borrower's /healthz to colour
  // the marketplace status pills. PayWithLocus checkout SDK also needs
  // the borrower endpoints reachable from the browser.
  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
  });

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

  const locus = createLocusClient({
    apiKey: config.locusApiKey,
    apiBase: config.locusApiBase,
    offline: config.locusOfflineMode,
    mockBalance: config.mockBalance,
  });
  const credit = new CreditClient(config.creditAgentUrl);

  app.get("/healthz", async () => ({ ok: true }));

  await workRoute(app, config, locus, credit);
  await workWithInputRoute(app, config, locus, credit);
  await webhooksRoute(app, config, locus, credit);

  return { app, locus, credit };
}

/**
 * Register this borrower with the Credit Agent. Discovers wallet address
 * via balance() against the borrower's Locus client.
 */
export async function registerWithCredit(
  config: BorrowerConfig,
  locus: LocusClientLike,
  credit: CreditClient,
): Promise<{ ok: boolean; score: number; limit: number }> {
  const bal = await locus.balance();
  // Wire field stays `borrowerId` for credit-agent DB compatibility.
  return credit.register({
    borrowerId: config.agentId,
    walletAddress: bal.wallet_address,
    serviceUrl: `http://localhost:${config.port}`,
    registrationApiKey: config.locusApiKey,
  });
}
