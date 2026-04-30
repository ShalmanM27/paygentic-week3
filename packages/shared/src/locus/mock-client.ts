// In-memory mock of the Locus client. Module-level state is shared across
// instances so multiple "wallets" can interact (credit pays a session that
// borrower created, etc.).
//
// Behavior is deterministic and fast:
//   - balance() returns LOCUS_MOCK_BALANCE env (default "10.00")
//   - createSession returns sess_mock_<n>; status PENDING
//   - preflight returns canPay:true unless session is PAID/EXPIRED
//   - agentPay flips session to PAID, returns tx_mock_<n>; tx_hash 0xmock<padded>
//   - getPayment returns CONFIRMED instantly
//   - waitForConfirm sleeps 1500ms then returns CONFIRMED
//   - send() returns synthetic snake_case shape matching SendUsdcResponse

import { createHash } from "node:crypto";

import type {
  AgentPayResponse,
  CheckoutSession,
  CheckoutSessionStatus,
  CreateSessionParams,
  PaymentStatus,
  PreflightResponse,
  SendUsdcResponse,
  WalletBalance,
} from "./types.js";

interface MockSession {
  id: string;
  status: CheckoutSessionStatus;
  amount: string;
  currency: string;
  expiresAt: string;
  createdAt: string;
  metadata?: Record<string, string>;
  checkoutUrl: string;
  sellerWalletAddress: string;
  /** apiKey of the seller — used by agentPay() to credit the receiver. */
  sellerApiKey: string;
  /** Set on the PENDING→PAID transition. Surfaced by getSession. */
  paymentTxHash?: string;
}

interface MockTransaction {
  id: string;
  sessionId: string;
  payerWallet: string;
  amount: string;
  status: "CONFIRMED";
  tx_hash: string;
  created_at: string;
}

const sessionRegistry = new Map<string, MockSession>();
const transactionRegistry = new Map<string, MockTransaction>();
const balanceByKey = new Map<string, string>();
let sessionSeq = 0;
let txSeq = 0;

/** Test/runtime hook: override the mock balance for a specific apiKey. */
export function setMockBalanceForKey(apiKey: string, balance: string): void {
  balanceByKey.set(apiKey, balance);
}

/**
 * Demo-only hook: flip a mock session to PAID and stamp a paymentTxHash.
 * Used by /debug/simulate-pay to fake a buyer paying a session in offline
 * mode (real payment flow goes through agentPay() which already does this).
 * Returns the updated session, or null if not found.
 */
export function markMockSessionPaid(
  sessionId: string,
  txHash?: string,
): { sessionId: string; status: string; paymentTxHash: string } | null {
  const s = sessionRegistry.get(sessionId);
  if (!s) return null;
  if (s.status !== "PENDING") {
    return {
      sessionId: s.id,
      status: s.status,
      paymentTxHash: s.paymentTxHash ?? "",
    };
  }
  txSeq += 1;
  const finalTxHash =
    txHash ?? `0xmock${txSeq.toString(16).padStart(58, "0")}`;
  s.status = "PAID";
  s.paymentTxHash = finalTxHash;
  sessionRegistry.set(sessionId, s);
  return { sessionId: s.id, status: "PAID", paymentTxHash: finalTxHash };
}

function nextSessionId(): string {
  sessionSeq += 1;
  return `sess_mock_${sessionSeq}`;
}

function nextTxId(): string {
  txSeq += 1;
  return `tx_mock_${txSeq}`;
}

function nextTxHash(): string {
  // 64 hex chars total, prefixed 0xmock
  const hex = txSeq.toString(16).padStart(58, "0");
  return `0xmock${hex}`;
}

function deterministicWallet(apiKey: string): string {
  // Real Ethereum addresses are exactly 42 chars (0x + 40 hex). Derive
  // a stable 40-char hex tail from sha256(apiKey) so route-level address
  // validation (/score, /score/:wallet/events, etc.) passes without
  // special-casing the offline mock.
  const hash = createHash("sha256").update(apiKey).digest("hex");
  return `0x${hash.slice(0, 40)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockLocusClient {
  private readonly apiKey: string;
  public readonly walletAddress: string;
  public readonly mockBalance: string;

  constructor(opts: { apiKey: string; mockBalance?: string }) {
    this.apiKey = opts.apiKey;
    this.walletAddress = deterministicWallet(opts.apiKey);
    this.mockBalance =
      opts.mockBalance ?? process.env.LOCUS_MOCK_BALANCE ?? "10.00";
  }

  async balance(): Promise<WalletBalance> {
    const override = balanceByKey.get(this.apiKey);
    return {
      wallet_address: this.walletAddress,
      workspace_id: "ws_mock",
      chain: "base",
      usdc_balance: override ?? this.mockBalance,
      promo_credit_balance: "0",
      allowance: null,
      max_transaction_size: null,
    };
  }

  async send(params: {
    toAddress: string;
    amount: number;
    memo: string;
  }): Promise<SendUsdcResponse> {
    const txId = nextTxId();
    const txHash = nextTxHash();
    transactionRegistry.set(txId, {
      id: txId,
      sessionId: "(send)",
      payerWallet: this.walletAddress,
      amount: String(params.amount),
      status: "CONFIRMED",
      tx_hash: txHash,
      created_at: new Date().toISOString(),
    });
    return {
      transaction_id: txId,
      queue_job_id: `job_mock_${txSeq}`,
      status: "QUEUED",
      from_address: this.walletAddress,
      to_address: params.toAddress,
      amount: params.amount,
      token: "USDC",
    };
  }

  async createSession(params: CreateSessionParams): Promise<CheckoutSession> {
    const id = nextSessionId();
    const now = new Date();
    const ttl = params.ttlSeconds ?? 3600;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const amount = String(params.amount);
    const currency = params.currency ?? "USDC";
    const session: MockSession = {
      id,
      status: "PENDING",
      amount,
      currency,
      expiresAt,
      createdAt: now.toISOString(),
      metadata: params.metadata,
      checkoutUrl: `https://beta.paywithlocus.com/pay/${id}`,
      sellerWalletAddress: this.walletAddress,
      sellerApiKey: this.apiKey,
    };
    sessionRegistry.set(id, session);
    return {
      id,
      status: "PENDING",
      amount,
      currency,
      expiresAt,
      checkoutUrl: session.checkoutUrl,
      metadata: params.metadata,
    };
  }

  async getSession(sessionId: string): Promise<CheckoutSession> {
    const s = sessionRegistry.get(sessionId);
    if (!s) {
      throw new Error(`mock: session ${sessionId} not found`);
    }
    return {
      id: s.id,
      status: s.status,
      amount: s.amount,
      currency: s.currency,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      metadata: s.metadata,
      paymentTxHash: s.paymentTxHash,
    };
  }

  /**
   * Mock equivalent of {@link LocusClient.waitForSessionSettled}.
   * Polls every 200ms (mock can be aggressive — no network) until the
   * session reaches a terminal status. Borrower /work uses this to wait
   * for the customer's pay before running processJob.
   */
  async waitForSessionSettled(
    sessionId: string,
    timeoutMs: number = 60_000,
  ): Promise<CheckoutSession> {
    const TERMINAL = new Set(["PAID", "EXPIRED", "CANCELLED"]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.getSession(sessionId);
      if (TERMINAL.has(String(session.status).toUpperCase())) {
        return session;
      }
      await sleep(200);
    }
    throw new Error(
      `mock: waitForSessionSettled timed out after ${timeoutMs}ms for ${sessionId}`,
    );
  }

  async preflight(sessionId: string): Promise<PreflightResponse> {
    const s = sessionRegistry.get(sessionId);
    if (!s) {
      throw new Error(`mock: session ${sessionId} not found`);
    }
    const canPay = s.status === "PENDING";
    return {
      canPay,
      agent: {
        walletAddress: this.walletAddress,
        availableBalance: "999999",
      },
      session: {
        id: s.id,
        amount: s.amount,
        currency: s.currency,
        description: null,
        status: s.status,
        expiresAt: s.expiresAt,
        sellerWalletAddress: s.sellerWalletAddress,
      },
      blockers: canPay ? undefined : [`session_status:${s.status}`],
    };
  }

  async agentPay(
    sessionId: string,
    _opts?: { payerEmail?: string },
  ): Promise<AgentPayResponse> {
    const s = sessionRegistry.get(sessionId);
    if (!s) {
      throw new Error(`mock: session ${sessionId} not found`);
    }
    if (s.status !== "PENDING") {
      throw new Error(`mock: session ${sessionId} status is ${s.status}`);
    }
    const txId = nextTxId();
    const txHash = nextTxHash();
    s.status = "PAID";
    s.paymentTxHash = txHash;
    sessionRegistry.set(sessionId, s);

    // Realistic balance flow: deduct from buyer, credit to seller — but
    // ONLY for wallets that are explicitly tracked via setMockBalanceForKey.
    // Untracked wallets keep returning their constructor mockBalance.
    const amt = Number(s.amount);
    if (Number.isFinite(amt)) {
      if (balanceByKey.has(this.apiKey)) {
        const current = Number(balanceByKey.get(this.apiKey));
        balanceByKey.set(this.apiKey, String(Math.max(0, current - amt)));
      }
      if (s.sellerApiKey && balanceByKey.has(s.sellerApiKey)) {
        const current = Number(balanceByKey.get(s.sellerApiKey));
        balanceByKey.set(s.sellerApiKey, String(current + amt));
      }
    }

    transactionRegistry.set(txId, {
      id: txId,
      sessionId,
      payerWallet: this.walletAddress,
      amount: s.amount,
      status: "CONFIRMED",
      tx_hash: txHash,
      created_at: new Date().toISOString(),
    });
    return {
      transactionId: txId,
      queueJobId: `job_mock_${txSeq}`,
      status: "queued",
      sessionId,
      amount: s.amount,
      currency: s.currency,
      statusEndpoint: `/api/checkout/agent/payments/${txId}`,
    };
  }

  async getPayment(transactionId: string): Promise<PaymentStatus> {
    const t = transactionRegistry.get(transactionId);
    if (!t) {
      throw new Error(`mock: transaction ${transactionId} not found`);
    }
    return {
      id: t.id,
      status: "CONFIRMED",
      amount_usdc: t.amount,
      tx_hash: t.tx_hash,
      block_number: 1_000_000 + txSeq,
      created_at: t.created_at,
    };
  }

  async waitForConfirm(
    transactionId: string,
    _timeoutMs: number,
  ): Promise<PaymentStatus> {
    await sleep(1500);
    return this.getPayment(transactionId);
  }
}

export function _resetMockState(): void {
  sessionRegistry.clear();
  transactionRegistry.clear();
  balanceByKey.clear();
  sessionSeq = 0;
  txSeq = 0;
}
