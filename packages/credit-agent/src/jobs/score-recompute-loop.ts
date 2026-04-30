// Recomputes every ACTIVE borrower's score every SCORE_LOOP_INTERVAL_SECONDS.
// Updates limit when score changes; emits score.changed; logs a score_event.

import { BorrowerModel, ScoreEventModel } from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { computeScore } from "../lib/score-compute.js";
import { publish } from "../lib/sse-bus.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function startScoreRecomputeLoop(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "score-recompute-loop: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const borrowers = await BorrowerModel.find({ status: "ACTIVE" });
      for (const b of borrowers) {
        if (stopped) break;
        try {
          const { score: newScore, components } = await computeScore(b.borrowerId);
          if (newScore === b.score) continue;
          const oldScore = b.score;
          b.score = newScore;
          // Limit formula caps at 4× MAX_LOAN_USDC so the displayed value
          // stays meaningful — a borrower can hold up to 4 simultaneous
          // max-sized loans before hitting the limit. Stops 580 → $40
          // when the system's actual max-loan size is $0.05.
          b.limit = Math.max(
            0,
            Math.min((newScore - 500) * 0.5, config.maxLoanUsdc * 4),
          );
          await b.save();
          await ScoreEventModel.create({
            borrowerId: b.borrowerId,
            type: "score_recomputed",
            delta: newScore - oldScore,
            reason: "periodic recompute",
            source: "loop",
            payload: { components },
            createdAt: new Date(),
          });
          publish({
            kind: "score.changed",
            ts: Date.now(),
            borrowerId: b.borrowerId,
            from: oldScore,
            to: newScore,
            components: components as unknown as Record<string, number>,
          });
          logger.info(
            { borrowerId: b.borrowerId, from: oldScore, to: newScore },
            "score recomputed",
          );
        } catch (err) {
          logger.error(
            { err, borrowerId: b.borrowerId },
            "score-recompute-loop: per-borrower error",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "score-recompute-loop: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, config.scoreLoopIntervalSeconds * 1000);
  handle.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
