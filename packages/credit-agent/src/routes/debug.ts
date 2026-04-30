// Dev-only routes. ALL gated by DEBUG_ENDPOINTS_ENABLED=1; return 404 otherwise.
//
//   GET  /debug/last-webhook       — recent verified webhook payloads
//   POST /debug/reset-demo         — truncate all collections
//   POST /debug/seed-borrower      — upsert a borrower with overrides

import type { FastifyInstance } from "fastify";
import {
  AgentSubscriptionModel,
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  ScoreEventModel,
  ScoreReportModel,
  TaskModel,
  TransactionModel,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import {
  recentWebhooks,
  _resetWebhookCapture,
} from "../lib/webhook-capture.js";
import { _resetDefaultedCache } from "../lib/default-loan.js";
import { applyDemoSeed } from "../lib/demo-seed.js";
import { markMockSessionPaid } from "@credit/shared";
import {
  handleRepaymentPaid,
  handleScoreReportPaid,
} from "./webhooks.js";

const seedSchema = {
  type: "object",
  required: ["borrowerId", "walletAddress"],
  additionalProperties: false,
  properties: {
    borrowerId: { type: "string", minLength: 1 },
    walletAddress: { type: "string", minLength: 1 },
    apiKey: { type: "string" },
    serviceUrl: { type: "string" },
    scoreOverride: { type: "number", minimum: 300, maximum: 850 },
    limitOverride: { type: "number", minimum: 0 },
  },
} as const;

interface SeedBody {
  borrowerId: string;
  walletAddress: string;
  apiKey?: string;
  serviceUrl?: string;
  scoreOverride?: number;
  limitOverride?: number;
}

export async function debugRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  // ── /debug/last-webhook ────────────────────────────────────────────
  app.get("/debug/last-webhook", async (_req, reply) => {
    if (!config.debugEndpointsEnabled) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { recent: recentWebhooks() };
  });

  // ── /debug/reset-demo ──────────────────────────────────────────────
  // Truncates financial collections, then re-seeds the existing borrowers
  // (preserving apiKey/wallet/serviceUrl from registration) to demo
  // presets via applyDemoSeed. Borrower records are NOT deleted — they
  // only register on boot, and deleting them would leave /credit/draw
  // returning borrower_not_found until we re-bounce the borrower processes.
  app.post("/debug/reset-demo", async (_req, reply) => {
    if (!config.debugEndpointsEnabled) {
      return reply.code(404).send({ error: "not_found" });
    }
    const [loans, queue, scoreEvents, scoreReports, txns, tasks, subs] =
      await Promise.all([
        LoanModel.deleteMany({}),
        RepaymentQueueModel.deleteMany({}),
        ScoreEventModel.deleteMany({}),
        ScoreReportModel.deleteMany({}),
        TransactionModel.deleteMany({}),
        TaskModel.deleteMany({}),
        AgentSubscriptionModel.deleteMany({}),
      ]);
    _resetWebhookCapture();
    _resetDefaultedCache();
    const { borrowersReset } = await applyDemoSeed(config);
    return {
      ok: true,
      cleared: {
        loans: loans.deletedCount ?? 0,
        repayment_queue: queue.deletedCount ?? 0,
        score_events: scoreEvents.deletedCount ?? 0,
        score_reports: scoreReports.deletedCount ?? 0,
        transactions: txns.deletedCount ?? 0,
        tasks: tasks.deletedCount ?? 0,
        agent_subscriptions: subs.deletedCount ?? 0,
      },
      borrowersReset,
    };
  });

  // ── /debug/seed-borrower ───────────────────────────────────────────
  app.post<{ Body: SeedBody }>(
    "/debug/seed-borrower",
    { schema: { body: seedSchema } },
    async (req, reply) => {
      if (!config.debugEndpointsEnabled) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { borrowerId, walletAddress, apiKey, serviceUrl } = req.body;
      const score = req.body.scoreOverride ?? 500;
      const limit = req.body.limitOverride ?? 0;
      const wallet = walletAddress.toLowerCase();
      const updated = await BorrowerModel.findOneAndUpdate(
        { borrowerId },
        {
          $set: {
            walletAddress: wallet,
            apiKey: apiKey ?? "claw_seed_placeholder",
            serviceUrl: serviceUrl ?? "http://localhost:0",
            score,
            limit,
          },
          $setOnInsert: {
            borrowerId,
            status: "ACTIVE",
            outstanding: 0,
            defaultCount: 0,
            registeredAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return {
        ok: true,
        borrower: {
          borrowerId: updated?.borrowerId,
          walletAddress: updated?.walletAddress,
          score: updated?.score,
          limit: updated?.limit,
          status: updated?.status,
        },
      };
    },
  );

  // ── /debug/simulate-pay ────────────────────────────────────────────
  // Offline-mode-only buyer-payment simulator. Flips a mock session to
  // PAID and triggers the matching webhook handler so loan/score-report
  // state advances. Used by /score/[wallet]'s "Simulate payment" button
  // when rehearsing the demo without a live Locus.
  app.post<{ Body: { sessionId: string } }>(
    "/debug/simulate-pay",
    {
      schema: {
        body: {
          type: "object",
          required: ["sessionId"],
          additionalProperties: false,
          properties: { sessionId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      if (!config.debugEndpointsEnabled) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (!config.locusOfflineMode) {
        return reply.code(400).send({
          error: "live_mode",
          message:
            "simulate-pay is offline-only. Use the real Locus checkout SDK in live mode.",
        });
      }
      const { sessionId } = req.body;
      const flipped = markMockSessionPaid(sessionId);
      if (!flipped) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // Dispatch to the matching handler (same code path as a real webhook).
      const log = req.log;
      const loan = await LoanModel.findOne({ repaymentSessionId: sessionId });
      if (loan) {
        await handleRepaymentPaid(loan.loanId, flipped.paymentTxHash, log);
      } else {
        const report = await ScoreReportModel.findOne({ sessionId });
        if (report) {
          await handleScoreReportPaid(sessionId, flipped.paymentTxHash, log);
        } else {
          log.info(
            { sessionId },
            "simulate-pay: no matching loan/report — session marked PAID only",
          );
        }
      }

      return {
        ok: true,
        sessionId: flipped.sessionId,
        status: flipped.status,
        paymentTxHash: flipped.paymentTxHash,
      };
    },
  );
}
