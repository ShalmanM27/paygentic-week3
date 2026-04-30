// Pure decision: do I have enough USDC to do this job, or must I borrow?
//
// Need = workCost - currentBalance + safetyBuffer
// If Need <= 0 → don't borrow.
// If Need  > 0 → borrow Need (Credit will reject if it exceeds the limit).

export interface DecideInput {
  workCost: number;
  balance: number;
  safetyBuffer: number;
}

export type DecideOutput =
  | { borrow: false; reason: string }
  | { borrow: true; amount: number };

export function decideBorrow(input: DecideInput): DecideOutput {
  const need = input.workCost - input.balance + input.safetyBuffer;
  if (need <= 0) {
    return { borrow: false, reason: "sufficient_balance" };
  }
  return { borrow: true, amount: round4(need) };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
