// Deterministic credit score: in [300, 850], cold-start 500.
// Recomputed every 30s from score_events.

export async function computeScore(_borrowerId: string): Promise<number> {
  throw new Error("not implemented");
}
