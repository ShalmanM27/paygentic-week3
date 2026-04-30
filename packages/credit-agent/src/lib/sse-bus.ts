// In-process SSE bus. Emits typed events; keeps a 100-event ring buffer
// so a fresh /events connection can replay recent activity.
//
// TODO: in-process only. Multi-process workers would need Redis pub/sub
// or similar — out of scope for hackathon.
//
// Naming note: the inner `purpose` field on session.* events would be
// `kind` per spec, but `kind` is the outer discriminator; renamed to
// `purpose` to avoid the name shadow.

import { EventEmitter } from "node:events";

export type SseEvent =
  | {
      kind: "loan.funded";
      ts: number;
      loanId: string;
      borrowerId: string;
      amount: number;
      repayAmount: number;
      dueAt: string;
      txHash: string | null;
      targetSessionId: string;
      repaymentSessionId: string;
      /** Set when the loan was drawn to fulfill an escrow-flow task. */
      linkedTaskId: string | null;
    }
  | {
      kind: "loan.repaid";
      ts: number;
      loanId: string;
      borrowerId: string;
      txHash: string | null;
      linkedTaskId: string | null;
    }
  | {
      kind: "loan.defaulted";
      ts: number;
      loanId: string;
      borrowerId: string;
      reason: string;
      linkedTaskId: string | null;
    }
  | {
      kind: "score.changed";
      ts: number;
      borrowerId: string;
      from: number;
      to: number;
      components?: Record<string, number>;
    }
  | {
      kind: "score.sold";
      ts: number;
      wallet: string;
      sessionId: string;
      amount: number;
    }
  | {
      kind: "session.paid";
      ts: number;
      sessionId: string;
      purpose: "repayment" | "score-report" | "unknown";
    }
  | {
      kind: "session.expired";
      ts: number;
      sessionId: string;
      purpose: "repayment" | "score-report" | "unknown";
    }
  | {
      kind: "system.heartbeat";
      ts: number;
      uptimeSec: number;
    }
  // ── Escrow-task lifecycle events (Phase X2) ─────────────────────────
  | { kind: "task.created"; ts: number; taskId: string; agentId: string; pricingUsdc: number }
  | { kind: "task.escrow_paid"; ts: number; taskId: string; agentId: string; txHash: string | null }
  | { kind: "task.dispatched"; ts: number; taskId: string; agentId: string }
  | { kind: "task.processing"; ts: number; taskId: string; agentId: string }
  | { kind: "task.borrowing"; ts: number; taskId: string; agentId: string }
  | { kind: "task.borrowed"; ts: number; taskId: string; agentId: string; loanId: string }
  | {
      kind: "task.delivered";
      ts: number;
      taskId: string;
      agentId: string;
      modelUsed: string | null;
      charsOutput: number;
    }
  | {
      kind: "task.released";
      ts: number;
      taskId: string;
      agentId: string;
      releaseTxHash: string | null;
    }
  | { kind: "task.failed"; ts: number; taskId: string; reason: string }
  | { kind: "task.refunded"; ts: number; taskId: string; refundExecuted: boolean }
  | { kind: "task.expired"; ts: number; taskId: string }
  // ── Agent registration / rent (Phase X4) ────────────────────────────
  | {
      kind: "agent.registered";
      ts: number;
      agentId: string;
      operatorId: string;
      subscriptionId: string;
    }
  | {
      kind: "agent.activated";
      ts: number;
      agentId: string;
      subscriptionId: string;
      coverageEndAt: string;
    }
  | { kind: "subscription.expired"; ts: number; subscriptionId: string };

export const sseBus = new EventEmitter();
sseBus.setMaxListeners(100);

const RING_SIZE = 100;
const buffer: SseEvent[] = [];

export function publish(event: SseEvent): void {
  buffer.push(event);
  if (buffer.length > RING_SIZE) buffer.shift();
  sseBus.emit("event", event);
}

export function subscribe(listener: (e: SseEvent) => void): () => void {
  sseBus.on("event", listener);
  return () => {
    sseBus.off("event", listener);
  };
}

export function recentEvents(): SseEvent[] {
  return [...buffer];
}

export function _resetBus(): void {
  buffer.length = 0;
  sseBus.removeAllListeners("event");
}
