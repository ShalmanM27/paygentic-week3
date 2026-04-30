// Escrow watcher loop. Polls /checkout/sessions/:id every 3s for tasks
// in DRAFT status. On PAID transition: persist, capture txHash + payer
// wallet (defensive parse), publish SSE, kick off dispatch.

import {
  TaskModel,
  type CheckoutSession,
} from "@credit/shared";
import type { CreditAgentConfig } from "../lib/config.js";
import { getLocusClient } from "../lib/locus.js";
import { publish } from "../lib/sse-bus.js";
import { dispatchTask } from "../lib/task-actions.js";

interface LoopLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const TICK_INTERVAL_MS = 3000;

export function startEscrowWatcher(deps: {
  logger: LoopLogger;
  config: CreditAgentConfig;
}): { stop: () => void } {
  const { logger, config } = deps;
  if (config.loopsDisabled) {
    logger.info({}, "escrow-watcher: LOOPS_DISABLED — not starting");
    return { stop: () => {} };
  }

  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const drafts = await TaskModel.find({
        status: { $in: ["DRAFT", "PAID"] },
      })
        .limit(50)
        .lean();
      for (const draft of drafts) {
        if (stopped) break;
        try {
          await checkOne(draft.taskId, config, logger);
        } catch (err) {
          logger.error(
            { err, taskId: draft.taskId },
            "escrow-watcher: per-item error",
          );
        }
      }
    } catch (err) {
      logger.error({ err }, "escrow-watcher: tick error");
    } finally {
      running = false;
    }
  }

  const handle = setInterval(tick, TICK_INTERVAL_MS);
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
  taskId: string,
  config: CreditAgentConfig,
  logger: LoopLogger,
): Promise<void> {
  const task = await TaskModel.findOne({ taskId });
  if (!task) return;

  // Re-dispatch path: a PAID task that hasn't yet transitioned to
  // DISPATCHED. The route's setTimeout retry covers most cases; this
  // gives us defense-in-depth if the process restarted between PAY
  // detection and dispatch.
  if (task.status === "PAID") {
    void dispatchTask(taskId, config, logger).catch(() => {});
    return;
  }

  if (task.status !== "DRAFT") return;

  const locus = getLocusClient();
  let session: CheckoutSession;
  try {
    session = await locus.getSession(task.escrowSessionId);
  } catch (err) {
    logger.warn(
      { taskId, sessionId: task.escrowSessionId, err: String(err) },
      "escrow-watcher: getSession failed",
    );
    return;
  }
  const upper = String(session.status).toUpperCase();
  if (upper === "PAID") {
    task.escrowSessionStatus = "PAID";
    task.escrowTxHash = session.paymentTxHash ?? null;
    // Defensive payerWalletAddress capture — beta may include this on
    // the PAID session response under various names.
    const sessAny = session as unknown as Record<string, unknown>;
    const payer =
      (typeof sessAny["payerAddress"] === "string"
        ? (sessAny["payerAddress"] as string)
        : undefined) ??
      (typeof sessAny["payerWalletAddress"] === "string"
        ? (sessAny["payerWalletAddress"] as string)
        : undefined) ??
      null;
    task.payerWalletAddress = payer;
    task.status = "PAID";
    await task.save();
    publish({
      kind: "task.escrow_paid",
      ts: Date.now(),
      taskId,
      agentId: task.agentId,
      txHash: task.escrowTxHash,
    });
    logger.info(
      { taskId, txHash: task.escrowTxHash },
      "escrow-watcher: task escrow paid → dispatching",
    );
    void dispatchTask(taskId, config, logger).catch((err) =>
      logger.error({ err, taskId }, "escrow-watcher: dispatch error"),
    );
  } else if (upper === "EXPIRED" || upper === "CANCELLED") {
    task.escrowSessionStatus = upper === "EXPIRED" ? "EXPIRED" : "CANCELLED";
    task.status = "EXPIRED";
    await task.save();
    publish({ kind: "task.expired", ts: Date.now(), taskId });
    logger.info({ taskId, status: upper }, "escrow-watcher: session terminal");
  }
}
