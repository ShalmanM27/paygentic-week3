// GET /stats — dashboard tickers. Computed from existing collections.

import type { FastifyInstance } from "fastify";
import {
  BorrowerModel,
  LoanModel,
  ScoreEventModel,
} from "@credit/shared";

export async function statsRoute(app: FastifyInstance): Promise<void> {
  app.get("/stats", async () => {
    const now = new Date();
    const todayUTC = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

    const [
      loansToday,
      loansFundedTotal,
      defaulted24h,
      terminal24h,
      defaultedTotal,
      terminalTotal,
      repaidLoans,
      activeBorrowers,
      openLoans,
      lastEvent,
    ] = await Promise.all([
      LoanModel.countDocuments({
        fundedAt: { $gte: todayUTC },
      }),
      LoanModel.countDocuments({
        status: { $in: ["FUNDED", "REPAID", "DEFAULTED"] },
      }),
      LoanModel.countDocuments({
        status: "DEFAULTED",
        closedAt: { $gte: dayAgo },
      }),
      LoanModel.countDocuments({
        status: { $in: ["REPAID", "DEFAULTED"] },
        closedAt: { $gte: dayAgo },
      }),
      LoanModel.countDocuments({ status: "DEFAULTED" }),
      LoanModel.countDocuments({
        status: { $in: ["REPAID", "DEFAULTED"] },
      }),
      LoanModel.find({ status: "REPAID" }).select("amount").lean(),
      BorrowerModel.countDocuments({ status: "ACTIVE" }),
      LoanModel.countDocuments({ status: "FUNDED" }),
      ScoreEventModel.findOne()
        .sort({ createdAt: -1 })
        .select("createdAt")
        .lean(),
    ]);

    const volumeUsdcSettled = repaidLoans.reduce(
      (s, l) => s + (l.amount ?? 0),
      0,
    );

    return {
      loansToday,
      loansFundedTotal,
      defaultRate24h: terminal24h > 0 ? defaulted24h / terminal24h : 0,
      defaultRateTotal:
        terminalTotal > 0 ? defaultedTotal / terminalTotal : 0,
      volumeUsdcSettled,
      activeBorrowers,
      openLoans,
      lastEventAt:
        (lastEvent as unknown as { createdAt?: Date } | null)?.createdAt
          ?.toISOString() ?? null,
    };
  });
}
