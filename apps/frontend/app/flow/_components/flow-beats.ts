// Shared beat timeline — single source of truth for graph + checklist
// + page-level banner. Each beat is a single narrative moment; together
// they form the demo's story arc.
//
// `startMs` = when the beat becomes ACTIVE (banner appears, orb takes
// off, side-effects begin). `confirmMs` = when the beat is settled
// (orb lands, vault fills/drains, balances update, checklist confirms).
// For beats with no flying orb, startMs === confirmMs.

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
  /** When true, the orb fragments at 60% progress and never reaches its
   *  destination (failure event). */
  fragments?: boolean;
}

export interface Beat {
  /** What the user sees as the loud headline above the graph. */
  title: string;
  /** Sub-line that explains what's happening in plain English. */
  desc: string;
  /** ALL CAPS shorthand for the checklist row title. */
  step: string;
  /** Sub-text under the checklist row title. */
  stepDetail: string;
  /** Optional flight orb. */
  orb?: BeatOrb;
  /** Side effect to apply at startMs / confirmMs. */
  effect?:
    | "vault_fill"
    | "vault_drain_to_borrower"
    | "vault_drain_to_user"
    | "processing_a"
    | "processing_b"
    | "stop_processing"
    | "blacklist_b";
  /** Final status after confirm — defaults to "confirmed". */
  confirmAs?: "confirmed" | "failed";
  /** Wall-clock ms after click. */
  startMs: number;
  /** Wall-clock ms after click — when orb lands / row confirms. */
  confirmMs: number;
  /** Optional borrower-A balance change at confirmMs. */
  balanceA?: number;
  /** Optional borrower-B balance change at confirmMs. */
  balanceB?: number;
  /** Optional user balance change at confirmMs. */
  balanceUser?: number;
}

export const ORB_DURATION_MS = 3200;
export const STEP_GAP_MS = 1500;

// Starting balances — chosen so the loan is meaningful (the borrower
// can't fulfill the work without it).
export const START_BALANCE_A = 0.001;
export const START_BALANCE_B = 0.0005;
export const START_BALANCE_USER = 0.05;

// HAPPY PATH (Borrower A) — 6 beats, paced for narration. Each
// money-orb beat gets ~2.6s of flight + ~1.2s of after-glow before the
// next beat starts so amounts/labels stay legible.
export const HAPPY_BEATS: Beat[] = [
  {
    title: "User pays $0.0080 USDC into escrow",
    desc:
      "Money leaves the User's wallet and is held by the Credit Platform until the agent delivers verified work.",
    step: "User pays escrow",
    stepDetail: "USER → CREDIT PLATFORM · $0.0080",
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
    title: "Credit Platform locks the escrow & dispatches the task",
    desc:
      "The vault fills with the held funds. The job is now assigned to Borrower A.",
    step: "Credit holds & dispatches",
    stepDetail: "Vault locked · agent acknowledged",
    effect: "vault_fill",
    startMs: 4600,
    confirmMs: 4600,
  },
  {
    title: "Credit extends a $0.0030 short-term loan to Borrower A",
    desc:
      "Borrower A only has $0.0010 in its wallet — too little to do the work. Credit lends the gap.",
    step: "Credit funds loan",
    stepDetail: "CREDIT → BORROWER A · $0.0030 (working capital)",
    orb: {
      from: "credit",
      to: "borrower-a",
      amount: 0.003,
      purpose: "loan",
      label: "$0.0030 loan",
    },
    startMs: 5800,
    confirmMs: 5800 + ORB_DURATION_MS, // 9000
    balanceA: START_BALANCE_A + 0.003,
  },
  {
    title: "Borrower A is doing the work",
    desc:
      "Agent is processing — paying gas + LLM costs from the funded balance.",
    step: "Borrower processes",
    stepDetail: "Agent working using funded balance",
    effect: "processing_a",
    startMs: 9800,
    confirmMs: 9800,
  },
  {
    title: "Borrower A repays the loan + interest",
    desc:
      "Work is done. Borrower returns $0.0031 (principal + tiny interest) to the Credit Platform.",
    step: "Borrower repays loan",
    stepDetail: "BORROWER A → CREDIT · $0.0031",
    orb: {
      from: "borrower-a",
      to: "credit",
      amount: 0.0031,
      purpose: "repay",
      label: "$0.0031 repay",
    },
    effect: "stop_processing",
    startMs: 12200,
    confirmMs: 12200 + ORB_DURATION_MS, // 15400
    balanceA: START_BALANCE_A + 0.003 - 0.0031,
  },
  {
    title: "Credit releases the escrow to Borrower A",
    desc:
      "Loan is closed. Vault drains. The full $0.0080 escrow flows to Borrower A as payment for verified delivery.",
    step: "Credit releases escrow",
    stepDetail: "CREDIT → BORROWER A · $0.0080 (final payment)",
    orb: {
      from: "credit",
      to: "borrower-a",
      amount: 0.008,
      purpose: "release",
      label: "$0.0080 release",
    },
    effect: "vault_drain_to_borrower",
    startMs: 16400,
    confirmMs: 16400 + ORB_DURATION_MS, // 19600
    balanceA: START_BALANCE_A + 0.003 - 0.0031 + 0.008,
  },
];

// DEFAULT PATH (Borrower B) — 7 beats, paced for narration.
export const DEFAULT_BEATS: Beat[] = [
  {
    title: "User pays $0.0080 USDC into escrow",
    desc:
      "Money leaves the User's wallet and is held by the Credit Platform.",
    step: "User pays escrow",
    stepDetail: "USER → CREDIT PLATFORM · $0.0080",
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
    title: "Credit Platform locks the escrow",
    desc: "The vault fills. The job is now assigned to Borrower B.",
    step: "Credit holds escrow",
    stepDetail: "Vault locked · agent acknowledged",
    effect: "vault_fill",
    startMs: 4600,
    confirmMs: 4600,
  },
  {
    title: "Credit funds Borrower B with a $0.0080 loan",
    desc:
      "Borrower B is nearly empty ($0.0005). Credit lends the full amount needed to attempt the work.",
    step: "Credit funds loan",
    stepDetail: "CREDIT → BORROWER B · $0.0080",
    orb: {
      from: "credit",
      to: "borrower-b",
      amount: 0.008,
      purpose: "loan",
      label: "$0.0080 loan",
    },
    startMs: 5800,
    confirmMs: 5800 + ORB_DURATION_MS, // 9000
    balanceB: START_BALANCE_B + 0.008,
  },
  {
    title: "Borrower B is attempting the work",
    desc: "Agent is processing — but its score history makes default likely.",
    step: "Borrower processes",
    stepDetail: "Agent working with borrowed funds",
    effect: "processing_b",
    startMs: 9800,
    confirmMs: 9800,
  },
  {
    title: "Repayment FAILS — agent ran out of funds",
    desc:
      "Borrower B's payment fragments mid-flight. Insufficient balance, max attempts reached.",
    step: "Repayment fails",
    stepDetail: "Insufficient funds · max attempts reached",
    orb: {
      from: "borrower-b",
      to: "credit",
      amount: 0.0081,
      purpose: "fail",
      label: "$0.0081 repay",
      fragments: true,
    },
    effect: "stop_processing",
    confirmAs: "failed",
    startMs: 12200,
    confirmMs: 12200 + ORB_DURATION_MS, // 15400
  },
  {
    title: "Credit auto-refunds the User",
    desc:
      "The held escrow is returned in full to the User. The vault drains back the way it came in.",
    step: "Credit refunds escrow",
    stepDetail: "CREDIT → USER · $0.0080 (auto-refund)",
    orb: {
      from: "credit",
      to: "user",
      amount: 0.008,
      purpose: "refund",
      label: "$0.0080 refund",
    },
    effect: "vault_drain_to_user",
    startMs: 16400,
    confirmMs: 16400 + ORB_DURATION_MS, // 19600
    balanceUser: START_BALANCE_USER,
  },
  {
    title: "Borrower B is blacklisted",
    desc:
      "Score crashed below the lend threshold. Agent is suspended from the marketplace.",
    step: "Borrower blacklisted",
    stepDetail: "Score crashed · agent suspended",
    effect: "blacklist_b",
    confirmAs: "failed",
    startMs: 20800,
    confirmMs: 20800,
  },
];

export function getBeats(scenario: ScenarioKind | null): Beat[] {
  if (scenario === "happy") return HAPPY_BEATS;
  if (scenario === "default") return DEFAULT_BEATS;
  return [];
}

// Deterministic mock hash from any string → 0x + hex.
export function mockHashFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return "0x" + h.toString(16).padStart(8, "0") + "mockflow";
}
