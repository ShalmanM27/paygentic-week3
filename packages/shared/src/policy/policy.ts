// Lending policy. Amounts denominated in USDC.
// Hackathon budget micro-amounts (≤$0.05). Loan principal capped at MAX_LOAN_USDC env.
// Min MIN_LOAN_USDC. Score reports SCORE_REPORT_PRICE.

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export function rateFor(score: number): number {
  if (score >= 800) return 0.05;
  if (score >= 700) return 0.08;
  if (score >= 600) return 0.12;
  if (score >= 500) return 0.18;
  return 0.99; // not lendable
}

export function repayAmount(
  principal: number,
  rate: number,
  ttlSeconds: number,
): number {
  const accrued = principal * rate * (ttlSeconds / SECONDS_PER_YEAR);
  return Math.max(principal + 0.0001, principal + accrued);
}
