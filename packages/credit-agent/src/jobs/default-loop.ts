// Force-default any FUNDED loan whose dueAt + grace has passed.

import { LoanModel } from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { defaultLoan } from "../lib/default-loan.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function startDefaultLoop(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "default-loop: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const cutoff = new Date(
        Date.now() - config.defaultGraceSeconds * 1000,
      );
      const overdue = await LoanModel.find({
        status: "FUNDED",
        dueAt: { $lt: cutoff },
      }).limit(50);

      for (const loan of overdue) {
        if (stopped) break;
        try {
          await defaultLoan({
            loanId: loan.loanId,
            reason: "due_date_passed",
            log: logger,
          });
        } catch (err) {
          logger.error(
            { err, loanId: loan.loanId },
            "default-loop: per-loan error",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "default-loop: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, config.defaultLoopIntervalSeconds * 1000);
  handle.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
