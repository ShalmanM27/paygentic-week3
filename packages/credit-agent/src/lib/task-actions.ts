// Internal task lifecycle actions: dispatch to agent, release escrow,
// refund escrow. Used by the tasks routes and the escrow watcher.

import { request as httpRequest } from "undici";
import {
  AgentModel,
  BorrowerModel,
  TaskModel,
  type Task,
} from "@credit/shared";
import type { CreditAgentConfig } from "./config.js";
import { getLocusClient } from "./locus.js";
import { publish } from "./sse-bus.js";
import { VIRTUAL_AGENT_PROMPTS } from "./agent-registry.js";
import { verifyTaskOutput } from "./task-verification.js";

interface ActionLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const DISPATCH_TIMEOUT_MS = 30_000;
const MAX_DISPATCH_ATTEMPTS = 3;

/** Send the task to the agent's /work-with-input. Updates task state. */
export async function dispatchTask(
  taskId: string,
  config: CreditAgentConfig,
  log: ActionLogger,
): Promise<void> {
  const task = await TaskModel.findOne({ taskId });
  if (!task) {
    log.warn({ taskId }, "dispatch: task not found");
    return;
  }
  if (task.status !== "PAID") {
    log.info({ taskId, status: task.status }, "dispatch: task not in PAID — skipping");
    return;
  }

  // Resolve the dispatch target. Prefer the borrower's registered
  // serviceUrl when present — that's the runtime address registered via
  // /credit/register, which can differ from the registry placeholder
  // (e.g. test harnesses bind borrowers on alt ports). For virtual
  // agents (translator/qa-tester/image-creator) there's no borrower
  // row, so we fall back to the AgentModel's serviceUrl.
  const borrower = await BorrowerModel.findOne({ borrowerId: task.agentId }).lean();
  const agent = await AgentModel.findOne({ agentId: task.agentId }).lean();
  const serviceUrl = borrower?.serviceUrl ?? agent?.serviceUrl;
  if (!serviceUrl) {
    log.warn({ taskId, agentId: task.agentId }, "dispatch: agent not registered");
    task.status = "FAILED";
    task.lastDispatchError = "agent_not_registered";
    await task.save();
    publish({
      kind: "task.failed",
      ts: Date.now(),
      taskId,
      reason: "agent_not_registered",
    });
    void refundTask(taskId, config, log).catch((err) =>
      log.error({ err, taskId }, "dispatch: refund after agent_not_registered failed"),
    );
    return;
  }

  task.dispatchAttempts = (task.dispatchAttempts ?? 0) + 1;
  const callbackUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}/deliver`;
  // Virtual agents inject a persona-specific system prompt via the
  // dispatch payload; real agents use their own configured prompt.
  const systemPromptOverride = VIRTUAL_AGENT_PROMPTS[task.agentId];

  let res;
  try {
    res = await httpRequest(`${serviceUrl.replace(/\/+$/, "")}/work-with-input`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        taskId,
        input: task.input,
        callbackUrl,
        ...(systemPromptOverride ? { systemPromptOverride } : {}),
      }),
      bodyTimeout: DISPATCH_TIMEOUT_MS,
      headersTimeout: DISPATCH_TIMEOUT_MS,
    });
  } catch (err) {
    task.lastDispatchError = err instanceof Error ? err.message : String(err);
    await task.save();
    log.warn(
      { taskId, attempt: task.dispatchAttempts, err: task.lastDispatchError },
      "dispatch: agent unreachable",
    );
    if (task.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
      task.status = "FAILED";
      await task.save();
      publish({
        kind: "task.failed",
        ts: Date.now(),
        taskId,
        reason: "max_dispatch_attempts",
      });
      void refundTask(taskId, config, log).catch(() => {});
    } else {
      // Schedule retry — the watcher loop will see status=PAID and re-dispatch.
      // Simpler: leave status=PAID, watcher's next tick re-dispatches.
      setTimeout(() => {
        void dispatchTask(taskId, config, log).catch(() => {});
      }, 10_000);
    }
    return;
  }

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    task.lastDispatchError = `agent_${res.statusCode}: ${text.slice(0, 200)}`;
    if (task.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
      task.status = "FAILED";
      await task.save();
      publish({ kind: "task.failed", ts: Date.now(), taskId, reason: task.lastDispatchError });
      void refundTask(taskId, config, log).catch(() => {});
    } else {
      await task.save();
      setTimeout(() => {
        void dispatchTask(taskId, config, log).catch(() => {});
      }, 10_000);
    }
    return;
  }

  task.status = "DISPATCHED";
  task.lastDispatchError = null;
  await task.save();
  publish({ kind: "task.dispatched", ts: Date.now(), taskId, agentId: task.agentId });
  log.info({ taskId, agentId: task.agentId }, "dispatch: agent accepted (202)");
}

/** Verify output, send escrow to agent's wallet, mark RELEASED. */
export async function releaseTask(
  taskId: string,
  log: ActionLogger,
  configOverride?: CreditAgentConfig,
): Promise<void> {
  const task = await TaskModel.findOne({ taskId });
  if (!task) {
    log.warn({ taskId }, "release: task not found");
    return;
  }
  if (task.status !== "DELIVERED") {
    log.info({ taskId, status: task.status }, "release: not in DELIVERED — skipping");
    return;
  }

  const verification = verifyTaskOutput({ output: task.output });
  task.verifiedAt = new Date();
  task.verificationNotes = verification.notes;

  if (!verification.passes) {
    task.status = "FAILED";
    await task.save();
    publish({
      kind: "task.failed",
      ts: Date.now(),
      taskId,
      reason: verification.notes,
    });
    void refundTask(taskId, configOverride!, log).catch((err) =>
      log.error({ err, taskId }, "release: refund after verification failure failed"),
    );
    return;
  }

  // Verification passed → send escrow USDC to the agent's wallet.
  // For virtual agents, fall back to the AgentModel walletAddress
  // (which is a placeholder for built-in virtuals — production would
  // require a real claim address).
  const borrower = await BorrowerModel.findOne({ borrowerId: task.agentId });
  const agent = !borrower
    ? await AgentModel.findOne({ agentId: task.agentId }).lean()
    : null;
  const recipientWallet = borrower?.walletAddress ?? agent?.walletAddress;
  if (!recipientWallet) {
    task.status = "FAILED";
    task.verificationNotes = "agent_not_registered_at_release";
    await task.save();
    publish({
      kind: "task.failed",
      ts: Date.now(),
      taskId,
      reason: "agent_not_registered_at_release",
    });
    return;
  }

  const locus = getLocusClient();
  let releaseTxHash: string | null = null;
  try {
    const sendRes = await locus.send({
      toAddress: recipientWallet,
      amount: task.pricingUsdc,
      memo: `task ${taskId} release`,
    });
    // sendRes.transaction_id exists; tx_hash isn't returned by send() directly.
    // We don't poll status here (beta polling endpoint is broken); trust the
    // 200 response and record the transaction id placeholder.
    releaseTxHash = `(send_tx:${sendRes.transaction_id})`;
  } catch (err) {
    log.warn(
      { taskId, err: err instanceof Error ? err.message : String(err) },
      "release: send failed; persisting RELEASED w/ null tx",
    );
  }

  task.status = "RELEASED";
  task.escrowReleaseTxHash = releaseTxHash;
  await task.save();
  publish({
    kind: "task.released",
    ts: Date.now(),
    taskId,
    agentId: task.agentId,
    releaseTxHash,
  });
  log.info({ taskId, releaseTxHash }, "task released");
}

/** Mark task REFUNDED. If payerWalletAddress is known, send refund USDC. */
export async function refundTask(
  taskId: string,
  _config: CreditAgentConfig,
  log: ActionLogger,
): Promise<void> {
  const task = await TaskModel.findOne({ taskId });
  if (!task) {
    log.warn({ taskId }, "refund: task not found");
    return;
  }
  if (task.status === "RELEASED" || task.status === "REFUNDED") {
    log.info({ taskId, status: task.status }, "refund: already terminal — skipping");
    return;
  }

  let executed = false;
  if (task.payerWalletAddress) {
    try {
      const locus = getLocusClient();
      const sendRes = await locus.send({
        toAddress: task.payerWalletAddress,
        amount: task.pricingUsdc,
        memo: `task ${taskId} refund`,
      });
      task.escrowRefundTxHash = `(send_tx:${sendRes.transaction_id})`;
      executed = true;
    } catch (err) {
      log.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        "refund: send failed",
      );
    }
  } else {
    log.warn(
      { taskId },
      "refund: payerWalletAddress unknown — marking REFUNDED (cosmetic, no on-chain refund)",
    );
  }

  task.status = "REFUNDED";
  await task.save();
  publish({
    kind: "task.refunded",
    ts: Date.now(),
    taskId,
    refundExecuted: executed,
  });
}

/** Cast a TaskModel doc to a serializable shape for API responses. */
export function serializeTask(task: Task): Record<string, unknown> {
  const obj = (task as unknown as { toObject?: () => Record<string, unknown> })
    .toObject?.();
  return obj ?? (task as unknown as Record<string, unknown>);
}
