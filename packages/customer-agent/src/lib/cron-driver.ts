// Continuous demand driver. Picks a borrower (weighted) every JOB_INTERVAL
// and triggers a job. Started only when CONTINUOUS_MODE=true.

import type { LocusClientLike } from "@credit/shared";
import type { CustomerAgentConfig } from "./config.js";
import { trigger, type BorrowerId } from "./trigger.js";

interface DriverLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function pickBorrower(weightA: number): BorrowerId {
  return Math.random() < weightA ? "agent-a" : "agent-b";
}

export function startCronDriver(deps: {
  config: CustomerAgentConfig;
  locus: LocusClientLike;
  logger: DriverLogger;
}): { stop: () => void } {
  const { config, locus, logger } = deps;
  if (!config.continuousMode) {
    logger.info({}, "cron-driver: CONTINUOUS_MODE=false — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const borrowerId = pickBorrower(config.borrowerWeightA);
      const result = await trigger({ config, locus, log: logger }, { borrowerId });
      logger.info({ result }, "cron-driver: triggered");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "cron-driver: tick failed",
      );
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, config.jobIntervalSeconds * 1000);
  handle.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
