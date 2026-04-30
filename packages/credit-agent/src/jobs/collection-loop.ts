// Collection loop. Every COLLECTION_LOOP_INTERVAL_SECONDS:
// - claim WAITING items past nextAttemptAt (atomic findOneAndUpdate)
// - act AS the borrower's wallet (per-borrower createLocusClient)
// - if balance ≥ amount: preflight + agentPay + waitForConfirm
//   - in offline mode: no webhook fires, so call handleRepaymentPaid directly
//   - in live mode: rely on Locus webhook
// - if balance insufficient: schedule retry with backoff, default at max attempts

import {
  BorrowerModel,
  RepaymentQueueModel,
  createLocusClient,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { defaultLoan } from "../lib/default-loan.js";
import { handleRepaymentPaid } from "../routes/webhooks.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const CLAIM_LIMIT = 20;

function backoffSeconds(attempts: number, schedule: number[]): number {
  if (schedule.length === 0) return 30;
  const idx = Math.min(attempts - 1, schedule.length - 1);
  return schedule[idx] ?? schedule[schedule.length - 1] ?? 30;
}

export function startCollectionLoop(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "collection-loop: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const now = new Date();
      const candidates = await RepaymentQueueModel.find({
        state: "WAITING",
        nextAttemptAt: { $lte: now },
      })
        .limit(CLAIM_LIMIT)
        .lean();

      for (const cand of candidates) {
        if (stopped) break;
        const claimed = await RepaymentQueueModel.findOneAndUpdate(
          { _id: cand._id, state: "WAITING" },
          { $set: { state: "ATTEMPTING" }, $inc: { attempts: 1 } },
          { new: true },
        );
        if (!claimed) continue; // someone else got it

        try {
          await processOne(claimed.loanId, logger, config);
        } catch (err) {
          logger.error(
            { err, loanId: claimed.loanId },
            "collection-loop: tick error per item",
          );
          // ensure we don't leave it ATTEMPTING forever
          await RepaymentQueueModel.updateOne(
            { _id: claimed._id, state: "ATTEMPTING" },
            {
              $set: {
                state: "WAITING",
                lastError: err instanceof Error ? err.message : String(err),
                nextAttemptAt: new Date(Date.now() + 30_000),
              },
            },
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "collection-loop: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(
    tick,
    config.collectionLoopIntervalSeconds * 1000,
  );
  handle.unref?.();
  // Fire once immediately so test cycles aren't bottlenecked by the interval.
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function processOne(
  loanId: string,
  logger: LoopLogger,
  config: CreditAgentConfig,
): Promise<void> {
  const queue = await RepaymentQueueModel.findOne({ loanId });
  if (!queue) return;

  const borrower = await BorrowerModel.findOne({ borrowerId: queue.borrowerId });
  if (!borrower || borrower.status !== "ACTIVE") {
    queue.state = "FAILED";
    queue.lastError = "borrower_not_collectable";
    await queue.save();
    logger.warn(
      { loanId, borrowerId: queue.borrowerId },
      "collection: borrower missing or not ACTIVE — failing queue item",
    );
    return;
  }

  const borrowerLocus = createLocusClient({
    apiKey: borrower.apiKey,
    apiBase: config.locusApiBase,
    offline: config.locusOfflineMode,
    mockBalance: config.mockBalance,
  });

  const bal = await borrowerLocus.balance();
  const balanceNum = Number(bal.usdc_balance);
  logger.info(
    {
      loanId,
      borrowerId: queue.borrowerId,
      attempts: queue.attempts,
      balance: balanceNum,
      need: queue.amount,
    },
    "collection: attempt",
  );

  if (Number.isFinite(balanceNum) && balanceNum >= queue.amount) {
    // Try to pay.
    const pre = await borrowerLocus.preflight(queue.repaymentSessionId);
    if (!pre.canPay) {
      await scheduleRetry(loanId, "preflight_failed", queue.attempts, logger, config);
      return;
    }
    const pay = await borrowerLocus.agentPay(queue.repaymentSessionId);
    const payStatusUpper = String(pay.status).toUpperCase();
    const ACCEPTABLE_INFLIGHT = new Set(["QUEUED", "PROCESSING", "CONFIRMED"]);
    if (!ACCEPTABLE_INFLIGHT.has(payStatusUpper)) {
      await scheduleRetry(
        loanId,
        `pay_status:${pay.status}`,
        queue.attempts,
        logger,
        config,
      );
      return;
    }

    // Confirm via getSession polling (canonical beta path).
    try {
      const settled = await borrowerLocus.waitForSessionSettled(
        queue.repaymentSessionId,
        30_000,
      );
      const settledUpper = String(settled.status).toUpperCase();
      if (settledUpper === "PAID") {
        await RepaymentQueueModel.updateOne(
          { loanId },
          {
            $set: {
              state: "COMPLETED",
              locusTransactionId: pay.transactionId,
              settlementAttemptedAt: new Date(),
            },
          },
        );
        await handleRepaymentPaid(
          loanId,
          settled.paymentTxHash ?? null,
          logger,
        );
        return;
      }
      // EXPIRED / CANCELLED — unexpected. Schedule retry.
      await scheduleRetry(
        loanId,
        `settled_status:${settled.status}`,
        queue.attempts,
        logger,
        config,
      );
      return;
    } catch (err) {
      // Timeout. Schedule retry; the next tick will agentPay again
      // (idempotent at the system level — if the previous payment
      // actually went through, the session will be PAID and waitForSessionSettled
      // returns immediately on next attempt before we even reach agentPay).
      logger.warn(
        { loanId, err: err instanceof Error ? err.message : String(err) },
        "collection: waitForSessionSettled timed out — scheduling retry",
      );
      await scheduleRetry(
        loanId,
        "settlement_timeout",
        queue.attempts,
        logger,
        config,
      );
      return;
    }
  }

  // Insufficient balance.
  await scheduleRetry(loanId, "insufficient_balance", queue.attempts, logger, config);
}

async function scheduleRetry(
  loanId: string,
  reason: string,
  attempts: number,
  logger: LoopLogger,
  config: CreditAgentConfig,
): Promise<void> {
  const queue = await RepaymentQueueModel.findOne({ loanId });
  if (!queue) return;

  if (attempts >= queue.maxAttempts) {
    queue.state = "FAILED";
    queue.lastError = reason;
    await queue.save();
    await defaultLoan({
      loanId,
      reason: "max_attempts_reached",
      log: logger,
    });
    return;
  }

  const wait = backoffSeconds(attempts, config.repaymentBackoffSeconds);
  queue.state = "WAITING";
  queue.lastError = reason;
  queue.nextAttemptAt = new Date(Date.now() + wait * 1000);
  await queue.save();
  logger.info(
    { loanId, attempts, reason, retryInSec: wait },
    "collection: retry scheduled",
  );
}
