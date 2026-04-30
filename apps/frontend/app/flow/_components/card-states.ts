// Pure function: events → 5-card state. State is a function of input,
// no imperative mutation. Easy to reason about during demo.

import type { SseEvent } from "../../../lib/types";

export type CardStatus = "WAITING" | "ACTIVE" | "DONE" | "FAILED";

export interface CardData {
  status: CardStatus;
  data: Record<string, unknown>;
}

export interface FlowSnapshot {
  cards: [CardData, CardData, CardData, CardData, CardData];
  // active loan tracked across the page
  activeLoanId: string | null;
  // sessions known about for the active loan
  customerSessionId: string | null;
  targetSessionId: string | null;
  repaymentSessionId: string | null;
  // last event timestamp on the active loan
  lastEventAt: number | null;
  // flags
  isDefaulted: boolean;
}

export interface BuildArgs {
  events: SseEvent[]; // newest first (matches useCreditEvents)
  triggeredAt: number | null;
  triggerCustomerSessionId: string | null;
}

const EMPTY_CARDS: [CardData, CardData, CardData, CardData, CardData] = [
  { status: "WAITING", data: {} },
  { status: "WAITING", data: {} },
  { status: "WAITING", data: {} },
  { status: "WAITING", data: {} },
  { status: "WAITING", data: {} },
];

export function buildFlowSnapshot(args: BuildArgs): FlowSnapshot {
  const cards: [CardData, CardData, CardData, CardData, CardData] = [
    { status: "WAITING", data: {} },
    { status: "WAITING", data: {} },
    { status: "WAITING", data: {} },
    { status: "WAITING", data: {} },
    { status: "WAITING", data: {} },
  ];

  let activeLoanId: string | null = null;
  let customerSessionId: string | null = args.triggerCustomerSessionId;
  let targetSessionId: string | null = null;
  let repaymentSessionId: string | null = null;
  let lastEventAt: number | null = null;
  let isDefaulted = false;

  // Card 1 — REQUEST: ACTIVE as soon as we have a trigger.
  if (args.triggeredAt !== null) {
    cards[0] = {
      status: "ACTIVE",
      data: { triggeredAt: args.triggeredAt },
    };
    lastEventAt = args.triggeredAt;
  }

  // Walk events oldest→newest so later events override earlier (e.g. defaulted
  // overrides funded → committed).
  const ordered = [...args.events].reverse();

  // Find the FIRST loan.funded after the trigger and lock onto it.
  if (args.triggeredAt !== null) {
    for (const e of ordered) {
      if (
        e.kind === "loan.funded" &&
        e.ts >= args.triggeredAt - 1000
      ) {
        activeLoanId = e.loanId;
        targetSessionId = e.targetSessionId;
        repaymentSessionId = e.repaymentSessionId;
        break;
      }
    }
  }

  if (activeLoanId !== null) {
    for (const e of ordered) {
      if (e.ts < (args.triggeredAt ?? 0) - 1000) continue;

      if (e.kind === "loan.funded" && e.loanId === activeLoanId) {
        // Card 1 done (request sent and accepted)
        cards[0] = { status: "DONE", data: { sentAt: args.triggeredAt } };
        // Card 2 done (decision token + rate inferred from amount/repayAmount)
        const inferredRate = e.amount > 0 ? (e.repayAmount - e.amount) / e.amount : 0;
        cards[1] = {
          status: "DONE",
          data: {
            loanId: e.loanId,
            amount: e.amount,
            rate: inferredRate,
            repayAmount: e.repayAmount,
          },
        };
        // Card 3 done (disbursed)
        cards[2] = {
          status: "DONE",
          data: {
            txHash: e.txHash,
            transactionId: null,
            dueAt: e.dueAt,
          },
        };
        // Card 4 active (collection pending)
        cards[3] = {
          status: "ACTIVE",
          data: { repaymentSessionId: e.repaymentSessionId },
        };
        lastEventAt = e.ts;
      }

      if (
        e.kind === "session.paid" &&
        e.purpose === "repayment" &&
        e.sessionId === repaymentSessionId
      ) {
        // Pay accepted; treat as committed if not yet repaid.
        if (cards[3]?.status !== "DONE" && cards[3]?.status !== "FAILED") {
          cards[3] = { ...cards[3]!, data: { ...cards[3]!.data, paidEvent: true } };
        }
        lastEventAt = e.ts;
      }

      if (e.kind === "loan.repaid" && e.loanId === activeLoanId) {
        cards[3] = { status: "DONE", data: { ...cards[3]!.data } };
        cards[4] = {
          status: "DONE",
          data: {
            loanId: e.loanId,
            txHash: e.txHash,
          },
        };
        lastEventAt = e.ts;
      }

      if (e.kind === "loan.defaulted" && e.loanId === activeLoanId) {
        isDefaulted = true;
        cards[3] = {
          status: "FAILED",
          data: { reason: e.reason },
        };
        cards[4] = {
          status: "FAILED",
          data: {
            loanId: e.loanId,
            reason: e.reason,
          },
        };
        lastEventAt = e.ts;
      }
    }
  }

  return {
    cards,
    activeLoanId,
    customerSessionId,
    targetSessionId,
    repaymentSessionId,
    lastEventAt,
    isDefaulted,
  };
}

export const EMPTY_SNAPSHOT: FlowSnapshot = {
  cards: EMPTY_CARDS,
  activeLoanId: null,
  customerSessionId: null,
  targetSessionId: null,
  repaymentSessionId: null,
  lastEventAt: null,
  isDefaulted: false,
};
