// Core trigger flow: customer pays a borrower for one job.
// Reused by POST /trigger and the cron driver.

import { request as httpRequest } from "undici";
import type { LocusClientLike } from "@credit/shared";
import type { CustomerAgentConfig } from "./config.js";

export type BorrowerId = "agent-a" | "agent-b";

export interface TriggerInput {
  borrowerId: BorrowerId;
  url?: string;
}

export interface TriggerResult {
  borrowerId: BorrowerId;
  sessionId: string;
  transactionId: string;
  status: string;
}

interface TriggerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function trigger(
  deps: {
    config: CustomerAgentConfig;
    locus: LocusClientLike;
    log?: TriggerLogger;
  },
  input: TriggerInput,
): Promise<TriggerResult> {
  const url = input.url ?? "https://example.com/article";
  const serviceUrl =
    input.borrowerId === "agent-a"
      ? deps.config.borrowerAUrl
      : deps.config.borrowerBUrl;

  // 1. POST /work and expect 402.
  const workRes = await httpRequest(`${serviceUrl}/work`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ url }),
  });
  const workText = await workRes.body.text();
  let workJson: unknown = null;
  try {
    workJson = workText.length ? JSON.parse(workText) : null;
  } catch {
    /* ignore */
  }
  if (workRes.statusCode !== 402) {
    throw new Error(
      `borrower /work returned ${workRes.statusCode} (expected 402): ${workText.slice(0, 200)}`,
    );
  }
  const sessionId =
    workJson && typeof (workJson as Record<string, unknown>)["sessionId"] === "string"
      ? ((workJson as Record<string, unknown>)["sessionId"] as string)
      : "";
  if (!sessionId) {
    throw new Error("borrower /work response missing sessionId");
  }

  // 2. preflight.
  const pre = await deps.locus.preflight(sessionId);
  if (!pre.canPay) {
    throw new Error(
      `preflight blocked: ${(pre.blockers ?? []).join(",") || "(no blockers reported)"}`,
    );
  }

  // 3. agentPay.
  const pay = await deps.locus.agentPay(sessionId);

  deps.log?.info(
    {
      borrowerId: input.borrowerId,
      sessionId,
      transactionId: pay.transactionId,
      payStatus: pay.status,
    },
    "trigger: agentPay accepted",
  );

  return {
    borrowerId: input.borrowerId,
    sessionId,
    transactionId: pay.transactionId,
    status: pay.status,
  };
}
