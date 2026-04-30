// Local copy of the lending policy + tier helpers. Mirrors
// packages/shared/src/policy/policy.ts. Copied (not imported) because
// importing @credit/shared would drag mongoose into the browser bundle.

export function rateFor(score: number): number {
  if (score >= 800) return 0.05;
  if (score >= 700) return 0.08;
  if (score >= 600) return 0.12;
  if (score >= 500) return 0.18;
  return 0.99;
}

export function tierFor(score: number): "PRIME" | "GOOD" | "FAIR" | "SUBPRIME" | "BLOCKED" {
  if (score >= 800) return "PRIME";
  if (score >= 700) return "GOOD";
  if (score >= 600) return "FAIR";
  if (score >= 500) return "SUBPRIME";
  return "BLOCKED";
}
