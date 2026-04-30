// Subscription watcher loop. Polls /checkout/sessions/:id every 3s for
// agent_subscriptions in PENDING_PAYMENT. On PAID transition: persist
// settlement details, set coverage window, activate the linked agent,
// publish SSE.
//
// Same shape as escrow-watcher (escrow tasks). Kept separate for clarity
// — different state machine, different SSE events.

import {
  AgentModel,
  AgentSubscriptionModel,
  type CheckoutSession,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { getLocusClient } from "../lib/locus.js";
import { publish } from "../lib/sse-bus.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function startSubscriptionWatcher(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "subscription-watcher: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const pending = await AgentSubscriptionModel.find({
        status: "PENDING_PAYMENT",
      })
        .limit(50)
        .lean();
      for (const sub of pending) {
        if (stopped) break;
        try {
          await checkOne(sub.subscriptionId, config, logger);
        } catch (err) {
          logger.error(
            { err, subscriptionId: sub.subscriptionId },
            "subscription-watcher: per-item error",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "subscription-watcher: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(
    tick,
    Math.max(1, config.subscriptionWatcherIntervalSeconds) * 1000,
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
  subscriptionId: string,
  config: CreditAgentConfig,
  logger: LoopLogger,
): Promise<void> {
  const sub = await AgentSubscriptionModel.findOne({ subscriptionId });
  if (!sub) return;
  if (sub.status !== "PENDING_PAYMENT") return;

  const locus = getLocusClient();
  let session: CheckoutSession;
  try {
    session = await locus.getSession(sub.escrowSessionId);
  } catch (err) {
    logger.warn(
      {
        subscriptionId,
        sessionId: sub.escrowSessionId,
        err: String(err),
      },
      "subscription-watcher: getSession failed",
    );
    return;
  }
  const upper = String(session.status).toUpperCase();

  if (upper === "PAID") {
    sub.escrowSessionStatus = "PAID";
    sub.escrowTxHash = session.paymentTxHash ?? null;
    sub.status = "ACTIVE";
    const now = new Date();
    sub.coverageStartAt = now;
    sub.coverageEndAt = new Date(
      now.getTime() + config.agentRentCoverageDays * DAY_MS,
    );
    await sub.save();

    const agent = await AgentModel.findOne({ agentId: sub.agentId });
    if (agent) {
      agent.isActive = true;
      agent.activatedAt = now;
      await agent.save();
    }

    publish({
      kind: "agent.activated",
      ts: Date.now(),
      agentId: sub.agentId,
      subscriptionId: sub.subscriptionId,
      coverageEndAt: sub.coverageEndAt.toISOString(),
    });
    logger.info(
      {
        subscriptionId,
        agentId: sub.agentId,
        coverageEndAt: sub.coverageEndAt,
      },
      "subscription-watcher: rent paid → agent activated",
    );
  } else if (upper === "EXPIRED" || upper === "CANCELLED") {
    sub.escrowSessionStatus = upper === "EXPIRED" ? "EXPIRED" : "CANCELLED";
    sub.status = "EXPIRED";
    await sub.save();
    publish({
      kind: "subscription.expired",
      ts: Date.now(),
      subscriptionId: sub.subscriptionId,
    });
    logger.info(
      { subscriptionId, status: upper },
      "subscription-watcher: rent session terminal — subscription expired",
    );
  }
}
