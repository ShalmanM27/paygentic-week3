// Orchestration for a paid /work job:
//   balance check → maybe borrow → do work → POST result to callback.

import { request as httpRequest } from "undici";
import { setMockBalanceForKey, type LocusClientLike } from "@credit/shared";
import type { BorrowerConfig } from "../server.js";
import { CreditClient } from "./credit-client.js";
import { decideBorrow } from "./decide-borrow.js";
import { doWork } from "./do-work.js";
import { takeJob } from "./job-store.js";

interface ProcessLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function processJob(
  sessionId: string,
  deps: {
    config: BorrowerConfig;
    locus: LocusClientLike;
    credit: CreditClient;
    log: ProcessLogger;
  },
): Promise<void> {
  // Atomic claim — protects against double-execution (background settle
  // watcher + synthesized webhook can both fire for the same session).
  const job = takeJob(sessionId);
  if (!job) {
    deps.log.info({ sessionId }, "processJob: job already taken — skipping");
    return;
  }

  const bal = await deps.locus.balance();
  const balanceNum = Number(bal.usdc_balance);

  const decision = decideBorrow({
    workCost: deps.config.workCost,
    balance: balanceNum,
    safetyBuffer: deps.config.safetyBuffer,
  });

  if (decision.borrow) {
    deps.log.info(
      { sessionId, balance: balanceNum, need: decision.amount },
      "processJob: borrowing",
    );
    const draw = await deps.credit.draw({
      borrowerId: deps.config.borrowerId,
      amount: decision.amount,
      purpose: "wrapped-api/scrape",
      ttl: 3600,
    });
    if (!draw.approved) {
      deps.log.error({ sessionId, draw }, "processJob: draw rejected");
      throw new Error(`draw rejected: ${draw.reason}`);
    }
    const cost = await deps.locus.createSession({
      amount: String(decision.amount),
      currency: "USDC",
      receiptConfig: {
        enabled: true,
        fields: {
          creditorName: deps.config.borrowerId,
          lineItems: [
            { description: `Cost cover for ${job.url}`, amount: String(decision.amount) },
          ],
        },
      },
      metadata: {
        kind: "borrower-cost",
        forSessionId: sessionId,
        borrowerId: deps.config.borrowerId,
      },
      ttlSeconds: 600,
    });
    const fund = await deps.credit.fund({
      decisionToken: draw.decisionToken,
      targetSessionId: cost.id,
    });
    deps.log.info(
      { sessionId, loanId: fund.loanId, repayAmount: fund.repayAmount },
      "processJob: loan funded",
    );
  } else {
    deps.log.info(
      { sessionId, balance: balanceNum, reason: decision.reason },
      "processJob: skipping borrow",
    );
  }

  const result = await doWork({ url: job.url });

  // In offline mode, simulate the on-chain portion of the work-cost as a
  // real balance drain. Production: the wrapped API call would deduct USDC.
  // Note: we drain workCost * 0.5 — workCost is the BUDGETED upper bound
  // borrower uses for decide-borrow, but actual on-chain cost is typically
  // less (some of the budget covers off-chain compute). Realistic, and lets
  // healthy borrowers retain enough to repay.
  if (deps.config.locusOfflineMode) {
    try {
      const bal = await deps.locus.balance();
      const drain = deps.config.workCost * 0.5;
      const remaining = Math.max(0, Number(bal.usdc_balance) - drain);
      setMockBalanceForKey(deps.config.locusApiKey, String(remaining));
      deps.log.info(
        { sessionId, drained: drain, remaining },
        "processJob: simulated work-cost drain",
      );
    } catch (err) {
      deps.log.warn({ err }, "processJob: work-cost drain failed");
    }
  }

  // POST result to customer's callback URL if one was supplied.
  if (job.callbackUrl) {
    try {
      const cbRes = await httpRequest(job.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, result }),
      });
      await cbRes.body.text(); // drain
      deps.log.info(
        { sessionId, callbackUrl: job.callbackUrl, status: cbRes.statusCode },
        "processJob: result delivered",
      );
    } catch (err) {
      deps.log.error(
        { sessionId, err, callbackUrl: job.callbackUrl },
        "processJob: callback failed",
      );
    }
  } else {
    deps.log.info({ sessionId }, "processJob: no callbackUrl — skipping delivery");
  }
}
