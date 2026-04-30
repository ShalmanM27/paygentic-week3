// Locus API request/response shapes.
//
// Field naming convention
// -----------------------
// Locus uses snake_case end-to-end. Types below mirror that exactly.
// Keys MUST match Locus's wire format — no camelCase wrappers.
//
// Confirmed from live API call (2026-04-29):
//   - WalletBalance        (snake_case)
//   - CheckoutSession      (camelCase; checkoutUrl on create only;
//                           createdAt + metadata on getSession only;
//                           webhookSecret NOT returned per session)
//   - PreflightResponse    (camelCase; FLAT envelope, not wrapped)
// Inferred from CLAUDE.md docs (verify on next live call):
//   - SendUsdcResponse     (snake_case per docs example)
//   - AgentPayResponse
//   - PaymentStatus
//
// Envelope discovery: Locus uses BOTH wrapped {success, data} (e.g.
// /pay/balance, /checkout/sessions) and flat {success, ...fields}
// (e.g. /checkout/agent/preflight). The client handles both.
//
// USDC amounts come back from Locus as decimal strings to avoid float rounding;
// we mirror that here as `Money` and let callers parse only when they must.

export type Money = string;

export type LocusEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: string; message: string };

// CONFIRMED LIVE 2026-04-29 via GET /pay/balance
export interface WalletBalance {
  wallet_address: string;
  workspace_id: string;
  chain: string; // observed: "base"
  usdc_balance: Money;
  promo_credit_balance: Money;
  allowance: Money | null;
  max_transaction_size: Money | null;
}

// CONFIRMED LIVE 2026-04-29 via POST /pay/send.
// Note: amount comes back as a JavaScript NUMBER (not a string). This
// breaks the Money-is-always-a-string convention used elsewhere on the
// platform. Documented, accepted, isolated to this endpoint.
export interface SendUsdcResponse {
  transaction_id: string;
  queue_job_id: string;
  status:
    | "PENDING"
    | "QUEUED"
    | "PROCESSING"
    | "CONFIRMED"
    | "FAILED"
    | "POLICY_REJECTED";
  from_address: string;
  to_address: string;
  amount: number; // ← number, not Money. Locus quirk.
  token: "USDC";
}

export interface ReceiptLineItem {
  description: string;
  amount: Money;
}

// REQUEST body for createSession. Per CLAUDE.md's docs excerpt the create
// endpoint accepts camelCase keys (receiptConfig, lineItems, whiteLabel).
// Keep camelCase here — do NOT preemptively snake_case. Confirm on first call.
export interface ReceiptConfig {
  enabled: boolean;
  whiteLabel?: boolean;
  fields?: {
    creditorName?: string;
    logoUrl?: string;
    supportEmail?: string;
    lineItems?: ReceiptLineItem[];
    taxAmount?: Money;
  };
}

export interface CreateSessionParams {
  amount: Money | number;
  currency?: "USDC";
  receiptConfig?: ReceiptConfig;
  metadata?: Record<string, string>;
  ttlSeconds?: number;
  webhookUrl?: string;
}

export type CheckoutSessionStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

// CONFIRMED LIVE 2026-04-29 against beta — camelCase end-to-end on this endpoint.
// Notes:
//   - checkoutUrl is present on createSession response, omitted on getSession.
//   - createdAt + metadata are present on getSession, omitted on createSession.
//   - webhookSecret is NOT returned per-session in beta. Treat it as
//     account-level: pull whsec_ from each service's .env on webhook verify.
export interface CheckoutSession {
  id: string;
  status: CheckoutSessionStatus;
  amount: Money;
  currency: string;
  expiresAt: string;
  createdAt?: string;
  checkoutUrl?: string;
  metadata?: Record<string, string>;
  /**
   * Present once status transitions to PAID. Discovered via
   * GET /checkout/sessions/:id polling — the canonical confirmation
   * path in beta (see CLAUDE.md "getSession polling" decision).
   */
  paymentTxHash?: string;
}

// CONFIRMED LIVE 2026-04-29 — preflight uses a FLAT envelope and a
// session-subobject that is NOT a subset of CheckoutSession. Different
// field names (sellerWalletAddress vs (no merchantAddress on session)),
// different nested fields (description). Type independently.
export interface PreflightAgentInfo {
  walletAddress: string;
  /** Observed "999999" — likely a sentinel for "no allowance configured". */
  availableBalance: Money;
}

export interface PreflightSessionInfo {
  id: string;
  amount: Money;
  currency: string;
  description: string | null;
  status: CheckoutSessionStatus;
  expiresAt: string;
  sellerWalletAddress: string;
}

export interface PreflightResponse {
  canPay: boolean;
  agent: PreflightAgentInfo;
  session: PreflightSessionInfo;
  blockers?: string[];
}

// CONFIRMED LIVE 2026-04-30: camelCase keys, LOWERCASE status enum.
// Differs from /pay/send (snake_case + UPPERCASE). Honor each endpoint.
export interface AgentPayResponse {
  transactionId: string;
  queueJobId: string;
  status:
    | "queued"
    | "processing"
    | "confirmed"
    | "failed"
    | "policy_rejected";
  sessionId: string;
  amount: Money;
  currency: string;
  /** Convenience polling path; we ignore it. */
  statusEndpoint: string;
  message?: string;
}

export type PaymentStatusValue =
  | "pending"
  | "queued"
  | "processing"
  | "confirmed"
  | "failed"
  | "policy_rejected"
  | "PENDING"
  | "QUEUED"
  | "PROCESSING"
  | "CONFIRMED"
  | "FAILED"
  | "POLICY_REJECTED";

// TODO: collapse after re-running smoke captures real shape.
// Dual-cased fields are temporary scaffolding.
export interface PaymentStatus {
  id?: string;
  transactionId?: string;
  status: PaymentStatusValue;
  amount_usdc?: Money;
  amountUsdc?: Money;
  tx_hash?: string;
  txHash?: string;
  block_number?: number;
  blockNumber?: number;
  failure_reason?: string;
  failureReason?: string;
  error_stage?: string;
  errorStage?: string;
  created_at?: string;
  createdAt?: string;
}

export type WebhookEventType =
  | "checkout.session.paid"
  | "checkout.session.expired";

export interface WebhookEvent {
  type: WebhookEventType;
  data: {
    sessionId: string;
    amount?: Money;
    txHash?: string;
    payerAddress?: string;
    paidAt?: string;
    [k: string]: unknown;
  };
}
