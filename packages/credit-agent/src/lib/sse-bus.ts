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
    }
  | {
      kind: "loan.repaid";
      ts: number;
      loanId: string;
      borrowerId: string;
      txHash: string | null;
    }
  | {
      kind: "loan.defaulted";
      ts: number;
      loanId: string;
      borrowerId: string;
      reason: string;
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
    };

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
