// Frontend-side types. Mirrors @credit/shared without dragging in mongoose.

export type SessionPurpose = "repayment" | "score-report" | "unknown";

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
      purpose: SessionPurpose;
    }
  | {
      kind: "session.expired";
      ts: number;
      sessionId: string;
      purpose: SessionPurpose;
    }
  | {
      kind: "system.heartbeat";
      ts: number;
      uptimeSec: number;
    };

export type LoanStatus = "REQUESTED" | "FUNDED" | "REPAID" | "DEFAULTED";

export interface LoanRow {
  loanId: string;
  borrowerId: string;
  amount: number;
  interestRate: number;
  repayAmount: number;
  status: LoanStatus;
  disbursementTxHash: string | null;
  disbursementStatus?: string | null;
  repaymentTxHash: string | null;
  repaymentSessionId: string | null;
  targetSessionId: string | null;
  dueAt: string;
  createdAt?: string;
  fundedAt?: string;
  closedAt?: string | null;
}

export interface BorrowerRow {
  borrowerId: string;
  walletAddress: string;
  status: "ACTIVE" | "DEFAULTED" | "SUSPENDED";
  score: number;
  limit: number;
  outstanding: number;
  defaultCount: number;
  registeredAt?: string;
  updatedAt?: string;
}

export interface ScoreSummary {
  score: number;
  tier: string;
  openLoans: number;
  defaultCount: number;
  lastUpdate: string | null;
}

export interface ScoreReportCreated {
  sessionId: string;
  checkoutUrl: string | null;
  amount: number;
  currency: string;
}

export interface ScoreReportResult {
  wallet: string;
  score: number;
  tier: string;
  components: {
    deliverySuccessRate: number;
    refundRate: number;
    repaymentPunctuality: number;
    defaultCount: number;
    lifetimeRepaid: number;
    openLoanCount: number;
  };
  events: Array<{
    type: string;
    delta: number;
    reason: string;
    createdAt: string | null;
  }>;
}

export interface DrawApprovedResponse {
  approved: true;
  decisionToken: string;
  amount: number;
  rate: number;
  repayAmount: number;
  expiresAt: string;
  dueAt: string;
}

export interface FundResponse {
  loanId: string;
  disbursement: {
    transactionId: string;
    txHash: string | null;
    status: string;
  };
  repaymentSessionId: string;
  repayAmount: number;
  dueAt: string;
}

export interface TriggerResult {
  borrowerId: "agent-a" | "agent-b";
  sessionId: string;
  transactionId: string;
  status: string;
}
