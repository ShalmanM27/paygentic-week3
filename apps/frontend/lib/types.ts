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
      linkedTaskId: string | null;
    }
  | {
      kind: "loan.repaid";
      ts: number;
      loanId: string;
      borrowerId: string;
      txHash: string | null;
      linkedTaskId: string | null;
    }
  | {
      kind: "loan.defaulted";
      ts: number;
      loanId: string;
      borrowerId: string;
      reason: string;
      linkedTaskId: string | null;
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
    }
  // ── Escrow-task lifecycle events ───────────────────────────────────
  | { kind: "task.created"; ts: number; taskId: string; agentId: string; pricingUsdc: number }
  | { kind: "task.escrow_paid"; ts: number; taskId: string; agentId: string; txHash: string | null }
  | { kind: "task.dispatched"; ts: number; taskId: string; agentId: string }
  | { kind: "task.processing"; ts: number; taskId: string; agentId: string }
  | { kind: "task.borrowing"; ts: number; taskId: string; agentId: string }
  | { kind: "task.borrowed"; ts: number; taskId: string; agentId: string; loanId: string }
  | {
      kind: "task.delivered";
      ts: number;
      taskId: string;
      agentId: string;
      modelUsed: string | null;
      charsOutput: number;
    }
  | {
      kind: "task.released";
      ts: number;
      taskId: string;
      agentId: string;
      releaseTxHash: string | null;
    }
  | { kind: "task.failed"; ts: number; taskId: string; reason: string }
  | { kind: "task.refunded"; ts: number; taskId: string; refundExecuted: boolean }
  | { kind: "task.expired"; ts: number; taskId: string }
  // ── Agent registration / rent (Phase X4) ─────────────────────────────
  | {
      kind: "agent.registered";
      ts: number;
      agentId: string;
      operatorId: string;
      subscriptionId: string;
    }
  | {
      kind: "agent.activated";
      ts: number;
      agentId: string;
      subscriptionId: string;
      coverageEndAt: string;
    }
  | { kind: "subscription.expired"; ts: number; subscriptionId: string };

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

// ── Agent registry / tasks ─────────────────────────────────────────────

export interface AgentRegistryEntry {
  agentId: string;
  displayName: string;
  description: string;
  pricingUsdc: number;
  category: string;
  emoji: string;
  operatorId: string;
  operatorName: string;
  capabilities: string[];
  serviceUrl: string;
  walletAddress: string;
  isBuiltIn: boolean;
}

export type SubscriptionStatus = "PENDING_PAYMENT" | "ACTIVE" | "EXPIRED";

export interface AgentSubscriptionRow {
  subscriptionId: string;
  agentId: string;
  operatorId: string;
  rentUsdc: number;
  coverageStartAt: string | null;
  coverageEndAt: string | null;
  escrowSessionId: string;
  escrowSessionStatus: "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";
  escrowTxHash: string | null;
  status: SubscriptionStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentRow {
  agentId: string;
  displayName: string;
  description: string;
  category: string;
  emoji: string;
  pricingUsdc: number;
  operatorId: string;
  operatorName: string;
  operatorEmail?: string | null;
  serviceUrl: string;
  capabilities: string[];
  walletAddress: string;
  isBuiltIn: boolean;
  isActive: boolean;
  activatedAt: string | null;
  suspendedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegisterAgentBody {
  agentId: string;
  displayName: string;
  description: string;
  category: "Text" | "Engineering" | "Creative" | "Research";
  emoji: string;
  pricingUsdc: number;
  operatorName: string;
  operatorEmail: string;
  serviceUrl: string;
  walletAddress: string;
  capabilities: string[];
}

export interface RegisterAgentResponse {
  agent: AgentRow;
  subscription: AgentSubscriptionRow;
  checkoutUrl: string | null;
  sessionId: string;
}

export interface SubscriptionResponse {
  subscription: AgentSubscriptionRow;
  agent: AgentRow | null;
}

export type TaskStatus =
  | "DRAFT"
  | "PAID"
  | "DISPATCHED"
  | "PROCESSING"
  | "DELIVERED"
  | "RELEASED"
  | "FAILED"
  | "REFUNDED"
  | "EXPIRED";

export type EscrowSessionStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

export interface TaskRow {
  taskId: string;
  userIdentifier: string;
  agentId: string;
  input: string;
  pricingUsdc: number;
  escrowSessionId: string;
  /** Persisted at session-create time so the SDK iframe can mount
   *  against the right origin. Beta sessions live on
   *  `https://checkout.beta.paywithlocus.com`; the SDK defaults to
   *  the production origin and 404s on beta IDs without this. */
  escrowCheckoutUrl?: string | null;
  escrowSessionStatus: EscrowSessionStatus;
  escrowTxHash: string | null;
  escrowReleaseTxHash: string | null;
  escrowRefundTxHash: string | null;
  payerWalletAddress: string | null;
  status: TaskStatus;
  output: string | null;
  outputAt: string | null;
  verifiedAt: string | null;
  verificationNotes: string | null;
  modelUsed: string | null;
  borrowedToFulfill: boolean;
  loanId: string | null;
  dispatchAttempts: number;
  lastDispatchError: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTaskResponse {
  task: TaskRow;
  checkoutUrl: string | null;
  sessionId: string;
}

export interface ListTasksResponse {
  tasks: TaskRow[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface GetTaskResponse {
  task: TaskRow;
  agent: AgentRegistryEntry | null;
}
