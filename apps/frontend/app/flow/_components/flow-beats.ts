// Shared beat timeline — single source of truth for graph + checklist
// + page-level banner. Each beat is a single narrative moment; together
// they form the demo's story arc.
//
// Both scenarios use the same 5-step structure so the checklist looks
// identical for either Run Loan button — only the content of step 4
// and 5 differs (success vs failure).
//
//   1. User pays escrow                              (orb)
//   2. Credit dispatches to agent                    (vault fills)
//   3. Borrower does the work                        (processing dots)
//   4. Output delivered      / Verification fails    (terminal status)
//   5. Credit releases escrow / Credit refunds escrow (orb)

export type NodeId = "user" | "credit" | "borrower-a" | "borrower-b";
export type Purpose =
  | "escrow"
  | "loan"
  | "repay"
  | "release"
  | "refund"
  | "fail";
export type ScenarioKind = "happy" | "default";
export type BeatStatus = "pending" | "active" | "confirmed" | "failed";

export interface BeatOrb {
  from: NodeId;
  to: NodeId;
  amount: number;
  purpose: Purpose;
  label: string;
  fragments?: boolean;
}

export interface Beat {
  title: string;
  desc: string;
  step: string;
  stepDetail: string;
  orb?: BeatOrb;
  /** A graph-only orb that fires alongside the main beat (e.g. a loan
   *  disbursement during the "Borrower does the work" step). The
   *  checklist ignores this field, so we can keep 5 user-facing rows
   *  while the graph shows the full money story. */
  extraOrb?: BeatOrb;
  /** ms after the beat goes ACTIVE before the extraOrb spawns. Defaults
   *  to 0. */
  extraOrbDelayMs?: number;
  effect?:
    | "vault_fill"
    | "vault_drain_to_borrower"
    | "vault_drain_to_user"
    | "processing_a"
    | "processing_b"
    | "stop_processing"
    | "blacklist_b";
  confirmAs?: "confirmed" | "failed";
  startMs: number;
  confirmMs: number;
  balanceA?: number;
  balanceB?: number;
  balanceUser?: number;
}

export const ORB_DURATION_MS = 3200;
export const STEP_GAP_MS = 1500;

export const START_BALANCE_A = 0.001;
export const START_BALANCE_B = 0.0005;
export const START_BALANCE_USER = 0.05;

// HAPPY PATH (Borrower A) — 5 beats.
export const HAPPY_BEATS: Beat[] = [
  {
    title: "User pays $0.0080 USDC into escrow",
    desc:
      "Money leaves the User's wallet and is held by the Credit Platform until the agent delivers verified work.",
    step: "User pays escrow",
    stepDetail: "USER → CREDIT PLATFORM",
    orb: {
      from: "user",
      to: "credit",
      amount: 0.008,
      purpose: "escrow",
      label: "$0.0080 escrow",
    },
    startMs: 600,
    confirmMs: 600 + ORB_DURATION_MS, // 3800
    balanceUser: START_BALANCE_USER - 0.008,
  },
  {
    title: "Credit Platform dispatches the task",
    desc:
      "The vault fills with the held funds. The job is now assigned to Borrower A.",
    step: "Credit dispatches to agent",
    stepDetail: "Task handed off · agent acknowledged",
    effect: "vault_fill",
    startMs: 4600,
    confirmMs: 4600,
  },
  {
    title: "Borrower A is doing the work",
    desc:
      "Credit funds the working capital. Agent does the job and will repay from earnings.",
    step: "Borrower does the work",
    stepDetail: "Credit funds the work · agent processes",
    effect: "processing_a",
    extraOrb: {
      from: "credit",
      to: "borrower-a",
      amount: 0.003,
      purpose: "loan",
      label: "$0.0030 loan",
    },
    extraOrbDelayMs: 200,
    startMs: 5500,
    confirmMs: 5500,
  },
  {
    title: "Borrower A delivers the output",
    desc: "Agent posted the result back to the credit platform.",
    step: "Output delivered",
    stepDetail: "Agent posted result back to credit platform",
    effect: "stop_processing",
    startMs: 8000,
    confirmMs: 8000,
  },
  {
    title: "Credit releases the escrow to Borrower A",
    desc:
      "Verified delivery. The full $0.0080 escrow flows to Borrower A as payment.",
    step: "Credit releases escrow",
    stepDetail: "CREDIT → BORROWER (paid for verified delivery)",
    orb: {
      from: "credit",
      to: "borrower-a",
      amount: 0.008,
      purpose: "release",
      label: "$0.0080 release",
    },
    effect: "vault_drain_to_borrower",
    startMs: 9000,
    confirmMs: 9000 + ORB_DURATION_MS, // 12200
    balanceA: START_BALANCE_A + 0.008,
  },
];

// DEFAULT PATH (Borrower B) — 5 beats, same structure as happy path
// but step 4 fails and step 5 refunds the user instead of releasing.
export const DEFAULT_BEATS: Beat[] = [
  {
    title: "User pays $0.0080 USDC into escrow",
    desc:
      "Money leaves the User's wallet and is held by the Credit Platform.",
    step: "User pays escrow",
    stepDetail: "USER → CREDIT PLATFORM",
    orb: {
      from: "user",
      to: "credit",
      amount: 0.008,
      purpose: "escrow",
      label: "$0.0080 escrow",
    },
    startMs: 600,
    confirmMs: 600 + ORB_DURATION_MS, // 3800
    balanceUser: START_BALANCE_USER - 0.008,
  },
  {
    title: "Credit Platform dispatches the task",
    desc: "The vault fills. The job is now assigned to Borrower B.",
    step: "Credit dispatches to agent",
    stepDetail: "Task handed off · agent acknowledged",
    effect: "vault_fill",
    startMs: 4600,
    confirmMs: 4600,
  },
  {
    title: "Borrower B attempts the work",
    desc:
      "Credit funds the work. Agent attempts the job — but its score history flags risk of default.",
    step: "Borrower attempts work",
    stepDetail: "Credit funds the work · default likely",
    effect: "processing_b",
    extraOrb: {
      from: "credit",
      to: "borrower-b",
      amount: 0.008,
      purpose: "loan",
      label: "$0.0080 loan",
    },
    extraOrbDelayMs: 200,
    startMs: 5500,
    confirmMs: 5500,
  },
  {
    title: "Verification fails — agent ran out of funds",
    desc:
      "Borrower B couldn't complete the work. The platform's auto-refund fires next.",
    step: "Verification fails",
    stepDetail: "Agent failed to deliver · refund triggered",
    effect: "stop_processing",
    confirmAs: "failed",
    startMs: 8000,
    confirmMs: 8000,
  },
  {
    title: "Credit refunds the User",
    desc:
      "The held escrow is returned in full to the User. Borrower B is suspended.",
    step: "Credit refunds escrow",
    stepDetail: "CREDIT → USER (auto-refund on failure)",
    orb: {
      from: "credit",
      to: "user",
      amount: 0.008,
      purpose: "refund",
      label: "$0.0080 refund",
    },
    effect: "vault_drain_to_user",
    startMs: 9000,
    confirmMs: 9000 + ORB_DURATION_MS, // 12200
    balanceUser: START_BALANCE_USER,
  },
];

export function getBeats(scenario: ScenarioKind | null): Beat[] {
  if (scenario === "happy") return HAPPY_BEATS;
  if (scenario === "default") return DEFAULT_BEATS;
  return [];
}

export function mockHashFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return "0x" + h.toString(16).padStart(8, "0") + "mockflow";
}
