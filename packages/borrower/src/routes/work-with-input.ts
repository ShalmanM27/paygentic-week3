// POST /work-with-input — escrow-flow entry point.
//
// Unlike /work (which gates work behind a 402 + customer pay), this endpoint
// is invoked AFTER Credit has already collected escrow from the user. The
// agent's job: do the work and call back with the output. Credit then
// verifies and releases (or refunds) the escrow.
//
// Always returns 202 Accepted immediately; work runs in the background.

import { request as httpRequest } from "undici";
import { setMockBalanceForKey, type LocusClientLike } from "@credit/shared";
import type { FastifyInstance } from "fastify";
import type { BorrowerConfig } from "../server.js";
import { CreditClient } from "../lib/credit-client.js";
import { decideBorrow } from "../lib/decide-borrow.js";
import { doWork } from "../lib/do-work.js";

const bodySchema = {
  type: "object",
  required: ["taskId", "input", "callbackUrl"],
  additionalProperties: false,
  properties: {
    taskId: { type: "string", minLength: 1 },
    input: { type: "string", minLength: 1 },
    callbackUrl: { type: "string", minLength: 1 },
    // Optional persona override — credit-agent injects this when
    // dispatching virtual agents (translator, qa-tester, image-creator)
    // through a shared backend.
    systemPromptOverride: { type: "string", minLength: 1 },
  },
} as const;

interface WorkWithInputBody {
  taskId: string;
  input: string;
  callbackUrl: string;
  systemPromptOverride?: string;
}

interface RouteLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function workWithInputRoute(
  app: FastifyInstance,
  config: BorrowerConfig,
  locus: LocusClientLike,
  credit: CreditClient,
): Promise<void> {
  app.post<{ Body: WorkWithInputBody }>(
    "/work-with-input",
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { taskId, input, callbackUrl, systemPromptOverride } = req.body;
      req.log.info(
        { taskId, agentId: config.agentId, override: !!systemPromptOverride },
        "work-with-input: accepted",
      );

      const log = req.log;
      void runEscrowJob({
        taskId,
        input,
        callbackUrl,
        config,
        locus,
        credit,
        log,
        systemPromptOverride,
      }).catch((err) => {
        log.error({ err, taskId }, "work-with-input: job errored");
      });

      return reply.code(202).send({ accepted: true, taskId });
    },
  );
}

async function postNote(
  config: BorrowerConfig,
  taskId: string,
  type: "processing" | "borrowing" | "borrowed" | "doing-work",
  loanId?: string,
): Promise<void> {
  const url = `${config.creditAgentUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}/note`;
  await httpRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(loanId ? { type, loanId } : { type }),
  }).then((r) => r.body.text());
}

async function postDelivery(
  config: BorrowerConfig,
  callbackUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const res = await httpRequest(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  return { status: res.statusCode, text };
}

async function runEscrowJob(deps: {
  taskId: string;
  input: string;
  callbackUrl: string;
  config: BorrowerConfig;
  locus: LocusClientLike;
  credit: CreditClient;
  log: RouteLogger;
  systemPromptOverride?: string;
}): Promise<void> {
  const {
    taskId,
    input,
    callbackUrl,
    config,
    locus,
    credit,
    log,
    systemPromptOverride,
  } = deps;

  // Check balance and decide whether to borrow.
  const bal = await locus.balance();
  const balanceNum = Number(bal.usdc_balance);
  const decision = decideBorrow({
    workCost: config.workCost,
    balance: balanceNum,
    safetyBuffer: config.safetyBuffer,
  });

  if (decision.borrow) {
    log.info(
      { taskId, balance: balanceNum, need: decision.amount },
      "escrow-job: borrowing",
    );
    await postNote(config, taskId, "borrowing").catch(() => {});
    const draw = await credit.draw({
      borrowerId: config.agentId,
      amount: decision.amount,
      purpose: `escrow-task/${taskId}`,
      ttl: 3600,
      taskId,
    });
    if (!draw.approved) {
      log.error({ taskId, draw }, "escrow-job: draw rejected");
      await postDelivery(config, callbackUrl, {
        failed: true,
        reason: `draw_rejected:${draw.reason}`,
      }).catch(() => {});
      return;
    }
    const cost = await locus.createSession({
      amount: String(decision.amount),
      currency: "USDC",
      receiptConfig: {
        enabled: true,
        fields: {
          creditorName: config.agentName,
          lineItems: [
            {
              description: `Cost cover for ${config.agentId} task ${taskId}`,
              amount: String(decision.amount),
            },
          ],
        },
      },
      metadata: { kind: "borrower-cost", taskId, agentId: config.agentId },
      ttlSeconds: 600,
    });
    const fund = await credit.fund({
      decisionToken: draw.decisionToken,
      targetSessionId: cost.id,
    });
    log.info(
      { taskId, loanId: fund.loanId, repayAmount: fund.repayAmount },
      "escrow-job: loan funded",
    );
    await postNote(config, taskId, "borrowed", fund.loanId).catch(() => {});
  } else {
    log.info(
      { taskId, balance: balanceNum, reason: decision.reason },
      "escrow-job: skipping borrow",
    );
  }

  // Mark processing, then do the work.
  await postNote(config, taskId, "processing").catch(() => {});

  let result;
  try {
    result = await doWork({
      agentId: config.agentId,
      agentName: config.agentName,
      // Override takes precedence so dispatched virtual personas use
      // their registry-defined prompt instead of the host's default.
      systemPrompt: systemPromptOverride ?? config.systemPrompt,
      userInput: input,
      geminiModel: config.geminiModel,
      geminiApiKey: config.geminiApiKey,
      geminiApiBase: config.geminiApiBase,
      locusOfflineMode: config.locusOfflineMode,
    });
  } catch (err) {
    log.error({ err, taskId }, "escrow-job: doWork threw");
    await postDelivery(config, callbackUrl, {
      failed: true,
      reason: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return;
  }

  // Simulate work-cost on-chain drain in offline mode (mirror process-job).
  if (config.locusOfflineMode) {
    try {
      const fresh = await locus.balance();
      const drain = config.workCost * 0.5;
      const remaining = Math.max(0, Number(fresh.usdc_balance) - drain);
      setMockBalanceForKey(config.locusApiKey, String(remaining));
    } catch {
      /* non-fatal */
    }
  }

  const cb = await postDelivery(config, callbackUrl, {
    output: result.content,
    modelUsed: result.modelUsed,
  }).catch((err) => ({ status: 0, text: String(err) }));

  log.info(
    { taskId, callbackStatus: cb.status, charsOutput: result.charsOutput },
    "escrow-job: delivered",
  );
}
