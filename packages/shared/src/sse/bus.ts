// In-process SSE event bus. Owned by Credit Agent; consumed by /events route.

export type SseEvent =
  | { kind: "loan.funded"; loanId: string; borrowerId: string }
  | { kind: "loan.repaid"; loanId: string; txHash: string }
  | { kind: "loan.defaulted"; loanId: string; borrowerId: string }
  | { kind: "score.changed"; borrowerId: string; from: number; to: number };

export const sseBus = {
  emit(_event: SseEvent): void {
    throw new Error("not implemented");
  },
  subscribe(_listener: (event: SseEvent) => void): () => void {
    throw new Error("not implemented");
  },
};
