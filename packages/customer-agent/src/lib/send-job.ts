// Pick a borrower, POST /work, expect 402, preflight, agent-pay, await callback.

export interface SendJobInput {
  borrowerId: "agent-a" | "agent-b";
  url: string;
}

export async function sendJob(_input: SendJobInput): Promise<void> {
  throw new Error("not implemented");
}
