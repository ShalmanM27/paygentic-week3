// Webhooks: NOT IMPLEMENTED IN LOCUS BETA as of 2026-04-30.
// This handler is fully built (HMAC verify, dispatch, capture) and
// tested via synthesized requests in test-webhook-flow.ts. It will
// become live the moment Locus ships webhook delivery. Until then:
//
//   - getSession polling (waitForSessionSettled) is the canonical
//     confirmation path for the disbursement and collection flows.
//   - The handler stays here as a no-op-in-production safeguard;
//     if Locus ever delivers a webhook, we verify and dispatch it
//     correctly. Defense in depth.
//
// POST /webhooks/locus — verify HMAC, dispatch by event type + sessionId.
// Strategy: write-first, then ack 200. Hackathon trade-off.
// TODO: upgrade to outbox pattern for production.

import type { FastifyInstance } from "fastify";
import {
  BorrowerModel,
  LoanModel,
  RepaymentQueueModel,
  ScoreEventModel,
  ScoreReportModel,
  TransactionModel,
  parseWebhookEvent,
  verifyWebhookSignature,
  type WebhookEvent,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { publish } from "../lib/sse-bus.js";
import { captureWebhook } from "../lib/webhook-capture.js";

export async function webhooksRoute(
  app: FastifyInstance,
  config: CreditAgentConfig,
): Promise<void> {
  app.post("/webhooks/locus", async (req, reply) => {
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

    let event: WebhookEvent;
    try {
      event = parseWebhookEvent(rawBody);
    } catch (err) {
      req.log.warn({ err }, "webhook body unparseable");
      return reply
        .code(400)
        .send({ error: "malformed_event", reason: String(err) });
    }

    // Verified webhook — capture for /debug/last-webhook (ring buffer).
    captureWebhook({
      receivedAt: new Date().toISOString(),
      signatureHeader,
      headers: req.headers as unknown as Record<string, unknown>,
      rawBody,
      parsed: event,
    });

    try {
      await dispatch(event, req.log);
    } catch (err) {
      req.log.error({ err, event }, "webhook handler threw");
      return reply.code(500).send({ error: "handler_failed" });
    }
    return { ok: true };
  });
}

async function dispatch(
  event: WebhookEvent,
  log: { info: Function; warn: Function; error: Function },
): Promise<void> {
  const sessionId = event.data.sessionId;
  const txHash =
    typeof event.data.txHash === "string" ? event.data.txHash : null;

  // 1. Try to match a repayment session.
  const loan = await LoanModel.findOne({ repaymentSessionId: sessionId });
  if (loan) {
    if (event.type === "checkout.session.paid") {
      await handleRepaymentPaid(loan.loanId, txHash, log);
    } else if (event.type === "checkout.session.expired") {
      log.info(
        { loanId: loan.loanId, sessionId },
        "repayment session expired — collection loop owns default decision",
      );
      publish({
        kind: "session.expired",
        ts: Date.now(),
        sessionId,
        purpose: "repayment",
      });
    }
    return;
  }

  // 2. Try to match a score-report session.
  const report = await ScoreReportModel.findOne({ sessionId });
  if (report) {
    if (event.type === "checkout.session.paid") {
      await handleScoreReportPaid(sessionId, txHash, log);
    } else if (event.type === "checkout.session.expired") {
      log.info({ sessionId }, "score-report session expired");
      publish({
        kind: "session.expired",
        ts: Date.now(),
        sessionId,
        purpose: "score-report",
      });
    }
    return;
  }

  // 3. Unknown sessionId — log + publish + ack.
  log.info({ sessionId, type: event.type }, "webhook for unknown session");
  if (event.type === "checkout.session.paid") {
    publish({
      kind: "session.paid",
      ts: Date.now(),
      sessionId,
      purpose: "unknown",
    });
  } else if (event.type === "checkout.session.expired") {
    publish({
      kind: "session.expired",
      ts: Date.now(),
      sessionId,
      purpose: "unknown",
    });
  }
}

export async function handleRepaymentPaid(
  loanId: string,
  txHash: string | null,
  log: { info: Function; warn: Function },
): Promise<void> {
  const loan = await LoanModel.findOne({ loanId });
  if (!loan) {
    log.warn({ loanId }, "loan disappeared between dispatch and handler");
    return;
  }
  if (loan.status === "REPAID") {
    log.info({ loanId }, "duplicate repayment webhook — ignoring");
    return;
  }

  const now = new Date();
  loan.status = "REPAID";
  loan.closedAt = now;
  loan.repaymentTxHash = txHash;
  await loan.save();
  log.info({ loanId, txHash, borrowerId: loan.borrowerId }, "loan repaid");

  await BorrowerModel.updateOne(
    { borrowerId: loan.borrowerId },
    [
      {
        $set: {
          outstanding: {
            $max: [0, { $subtract: ["$outstanding", loan.repayAmount] }],
          },
        },
      },
    ],
  );

  await ScoreEventModel.create({
    borrowerId: loan.borrowerId,
    type: "loan_repaid",
    delta: 5,
    reason: `on-time repayment of ${loan.loanId}`,
    source: "webhook",
    payload: { loanId: loan.loanId, txHash, amount: loan.repayAmount },
    createdAt: now,
  });

  await TransactionModel.create({
    type: "repayment",
    borrowerId: loan.borrowerId,
    amount: loan.repayAmount,
    sessionId: loan.repaymentSessionId,
    txHash,
    locusTransactionId: null,
    status: "CONFIRMED",
    loanId: loan.loanId,
    createdAt: now,
  });

  await RepaymentQueueModel.updateOne(
    {
      loanId: loan.loanId,
      state: { $in: ["WAITING", "ATTEMPTING", "ATTEMPTING_SETTLED"] },
    },
    { $set: { state: "COMPLETED" } },
  );

  publish({
    kind: "loan.repaid",
    ts: Date.now(),
    loanId: loan.loanId,
    borrowerId: loan.borrowerId,
    txHash,
    linkedTaskId: loan.linkedTaskId ?? null,
  });
  publish({
    kind: "session.paid",
    ts: Date.now(),
    sessionId: loan.repaymentSessionId ?? "",
    purpose: "repayment",
  });
}

export async function handleScoreReportPaid(
  sessionId: string,
  txHash: string | null,
  log: { info: Function },
): Promise<void> {
  const now = new Date();
  const report = await ScoreReportModel.findOneAndUpdate(
    { sessionId, status: "PENDING" },
    {
      $set: {
        status: "CLAIMABLE",
        txHash,
        paidAt: now,
      },
    },
    { new: true },
  );
  if (!report) {
    log.info(
      { sessionId },
      "score-report session paid but already CLAIMABLE/DELIVERED — ignoring",
    );
    return;
  }

  await TransactionModel.create({
    type: "score_sale",
    borrowerId: null,
    amount: report.amount,
    sessionId,
    txHash,
    locusTransactionId: null,
    status: "CONFIRMED",
    loanId: null,
    createdAt: now,
  });

  publish({
    kind: "score.sold",
    ts: Date.now(),
    wallet: report.wallet,
    sessionId,
    amount: report.amount,
  });
  publish({
    kind: "session.paid",
    ts: Date.now(),
    sessionId,
    purpose: "score-report",
  });
}
