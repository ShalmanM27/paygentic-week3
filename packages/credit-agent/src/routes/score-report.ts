// POST /score-report           — create a paid Locus session for a full report.
// GET  /score-report/:id/result — return the report when CLAIMABLE; flip to DELIVERED.
//
// Component computation here is naive — full recompute lives in the score
// recompute loop when Phase 4 lands.

import type { FastifyInstance } from "fastify";
import {
  BorrowerModel,
  LoanModel,
  ScoreEventModel,
  ScoreReportModel,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { getLocusClient } from "../lib/locus.js";

const WALLET_RE = /^0x[0-9a-f]{40}$/;

function tierFor(score: number): string {
  if (score >= 800) return "PRIME";
  if (score >= 700) return "GOOD";
  if (score >= 600) return "FAIR";
  if (score >= 500) return "SUBPRIME";
  return "BLOCKED";
}

export async function scoreReportRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  // ── POST /score-report ─────────────────────────────────────────────
  app.post<{ Body: { wallet: string } }>(
    "/score-report",
    {
      schema: {
        body: {
          type: "object",
          required: ["wallet"],
          additionalProperties: false,
          properties: { wallet: { type: "string", minLength: 42, maxLength: 42 } },
        },
      },
    },
    async (req, reply) => {
      const wallet = req.body.wallet.toLowerCase();
      if (!WALLET_RE.test(wallet)) {
        return reply.code(400).send({ error: "invalid_wallet" });
      }
      const borrower = await BorrowerModel.findOne({ walletAddress: wallet });
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }

      const locus = getLocusClient();
      const session = await locus.createSession({
        amount: String(config.scoreReportPrice),
        currency: "USDC",
        receiptConfig: {
          enabled: true,
          fields: {
            creditorName: "CREDIT",
            lineItems: [
              {
                description: `Full credit report for ${wallet}`,
                amount: String(config.scoreReportPrice),
              },
            ],
          },
        },
        metadata: { wallet, kind: "score-report" },
        ttlSeconds: 600,
      });

      await ScoreReportModel.create({
        sessionId: session.id,
        wallet,
        status: "PENDING",
        amount: config.scoreReportPrice,
        createdAt: new Date(),
      });

      return {
        sessionId: session.id,
        checkoutUrl: session.checkoutUrl ?? null,
        amount: config.scoreReportPrice,
        currency: "USDC",
      };
    },
  );

  // ── GET /score-report/:sessionId/result ────────────────────────────
  app.get<{ Params: { sessionId: string } }>(
    "/score-report/:sessionId/result",
    async (req, reply) => {
      const { sessionId } = req.params;
      const report = await ScoreReportModel.findOne({ sessionId });
      if (!report) {
        return reply.code(404).send({ error: "report_not_found" });
      }
      if (report.status === "PENDING") {
        return reply.code(402).send({
          error: "not_paid_yet",
          checkoutUrl: `https://beta.paywithlocus.com/pay/${sessionId}`,
        });
      }

      // DELIVERED — return the locked snapshot.
      if (report.status === "DELIVERED" && report.snapshotScore !== null) {
        return {
          wallet: report.wallet,
          score: report.snapshotScore,
          tier: report.snapshotTier,
          components: report.snapshotComponents,
          events: report.snapshotEvents ?? [],
        };
      }

      // CLAIMABLE — compute fresh, snapshot, flip to DELIVERED.
      const borrower = await BorrowerModel.findOne({
        walletAddress: report.wallet,
      });
      if (!borrower) {
        return reply.code(404).send({ error: "borrower_not_found" });
      }

      const events = await ScoreEventModel.find({
        borrowerId: borrower.borrowerId,
      })
        .sort({ createdAt: -1 })
        .limit(50);

      const openLoanCount = await LoanModel.countDocuments({
        borrowerId: borrower.borrowerId,
        status: "FUNDED",
      });
      const repaidEvents = events.filter((e) => e.type === "loan_repaid");
      const defaultedEvents = events.filter((e) => e.type === "loan_defaulted");
      const totalTerminal = repaidEvents.length + defaultedEvents.length;
      const repaymentPunctuality =
        totalTerminal > 0 ? repaidEvents.length / totalTerminal : 0;
      const lifetimeRepaid = repaidEvents.reduce((sum, e) => {
        const amt = (e.payload as { amount?: number } | null)?.amount;
        return sum + (typeof amt === "number" ? amt : 0);
      }, 0);

      const components = {
        deliverySuccessRate: 0,
        refundRate: 0,
        repaymentPunctuality,
        defaultCount: borrower.defaultCount,
        lifetimeRepaid,
        openLoanCount,
      };
      const eventsOut = events.map((e) => ({
        type: e.type,
        delta: e.delta,
        reason: e.reason,
        createdAt:
          (e as unknown as { createdAt?: Date }).createdAt?.toISOString() ??
          null,
      }));
      const score = borrower.score;
      const tier = tierFor(score);

      report.status = "DELIVERED";
      report.deliveredAt = new Date();
      report.snapshotScore = score;
      report.snapshotTier = tier;
      report.snapshotComponents = components;
      report.snapshotEvents = eventsOut;
      await report.save();

      return {
        wallet: report.wallet,
        score,
        tier,
        components,
        events: eventsOut,
      };
    },
  );
}
