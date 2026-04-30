// Settlement watcher. Beta polling endpoints (/checkout/agent/payments/:id)
// return 403 even for the agent that initiated the payment, so we cannot
// rely on getPayment for confirmation. Webhooks are primary; this loop is
// the fallback that watches the borrower's on-chain balance for the drop.
//
// For each repayment_queue row in state=ATTEMPTING_SETTLED for > grace
// seconds: read borrower balance. If it has dropped by ≥ amount (within
// tolerance), assume the payment settled and call handleRepaymentPaid.

import {
  BorrowerModel,
  RepaymentQueueModel,
  createLocusClient,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { handleRepaymentPaid } from "../routes/webhooks.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const TOLERANCE = 0.0005;

export function startSettlementWatcher(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "settlement-watcher: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }
  if (!config.settlementWatcherEnabled) {
    // Disabled by default in beta — getSession polling is the canonical
    // confirmation path. Kept as defense-in-depth fallback.
    logger.info(
      {},
      "settlement-watcher: SETTLEMENT_WATCHER_ENABLED!=1 — not starting (default)",
    );
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const cutoff = new Date(
        Date.now() - config.settlementGraceSeconds * 1000,
      );
      const candidates = await RepaymentQueueModel.find({
        state: "ATTEMPTING_SETTLED",
        settlementAttemptedAt: { $lt: cutoff },
      })
        .limit(20)
        .lean();

      for (const q of candidates) {
        if (stopped) break;
        try {
          await checkOne(q.loanId, logger, config);
        } catch (err) {
          logger.error(
            { err, loanId: q.loanId },
            "settlement-watcher: per-item error",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "settlement-watcher: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(
    tick,
    config.settlementWatcherIntervalSeconds * 1000,
  );
  handle.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}

async function checkOne(
  loanId: string,
  logger: LoopLogger,
  config: CreditAgentConfig,
): Promise<void> {
  const queue = await RepaymentQueueModel.findOne({ loanId });
  if (!queue || queue.state !== "ATTEMPTING_SETTLED") return;
  if (queue.preAmountSnapshot == null) {
    logger.warn(
      { loanId },
      "settlement-watcher: missing preAmountSnapshot — cannot verify",
    );
    return;
  }

  const borrower = await BorrowerModel.findOne({ borrowerId: queue.borrowerId });
  if (!borrower) {
    logger.warn({ loanId }, "settlement-watcher: borrower missing");
    return;
  }

  const borrowerLocus = createLocusClient({
    apiKey: borrower.apiKey,
    apiBase: config.locusApiBase,
    offline: config.locusOfflineMode,
    mockBalance: config.mockBalance,
  });

  const bal = await borrowerLocus.balance();
  const currentBalance = Number(bal.usdc_balance);
  const expectedDrop = queue.amount - TOLERANCE;
  const observedDrop = queue.preAmountSnapshot - currentBalance;

  if (observedDrop >= expectedDrop) {
    logger.info(
      {
        loanId,
        preAmountSnapshot: queue.preAmountSnapshot,
        currentBalance,
        observedDrop,
        expectedDrop,
      },
      "settlement-watcher: balance drop observed — settling loan (no txHash)",
    );
    await handleRepaymentPaid(loanId, null, logger);
  } else {
    logger.info(
      {
        loanId,
        preAmountSnapshot: queue.preAmountSnapshot,
        currentBalance,
        observedDrop,
        expectedDrop,
      },
      "settlement-watcher: drop not yet observed",
    );
  }
}
