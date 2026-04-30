// Typed fetch wrappers for credit-agent + customer-agent. All cross-origin
// — relies on @fastify/cors on the agents.

import type {
  BorrowerRow,
  DrawApprovedResponse,
  FundResponse,
  LoanRow,
  ScoreReportCreated,
  ScoreReportResult,
  ScoreSummary,
  TriggerResult,
} from "./types";

const CREDIT_BASE =
  process.env.NEXT_PUBLIC_CREDIT_AGENT_URL ?? "http://localhost:4000";
const CUSTOMER_BASE =
  process.env.NEXT_PUBLIC_CUSTOMER_AGENT_URL ?? "http://localhost:4003";

async function jsonRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = { _nonjson: text };
  }
  if (!res.ok) {
    const err = new Error(
      `${url} → ${res.status}: ${typeof (body as { message?: string })?.message === "string" ? (body as { message: string }).message : JSON.stringify(body)}`,
    );
    (err as Error & { status?: number; body?: unknown }).status = res.status;
    (err as Error & { status?: number; body?: unknown }).body = body;
    throw err;
  }
  return body as T;
}

// ── credit-agent ────────────────────────────────────────────────────────

export const credit = {
  getScore(wallet: string): Promise<ScoreSummary> {
    return jsonRequest(
      `${CREDIT_BASE}/score?wallet=${encodeURIComponent(wallet)}`,
    );
  },

  createScoreReport(wallet: string): Promise<ScoreReportCreated> {
    return jsonRequest(`${CREDIT_BASE}/score-report`, {
      method: "POST",
      body: JSON.stringify({ wallet }),
    });
  },

  getScoreReportResult(sessionId: string): Promise<ScoreReportResult> {
    return jsonRequest(
      `${CREDIT_BASE}/score-report/${encodeURIComponent(sessionId)}/result`,
    );
  },

  // Phase 8 backend additions — implemented in checkpoint 3.
  async listTransactions(params?: {
    type?: string;
    borrowerId?: string;
    offset?: number;
    limit?: number;
  }): Promise<{
    rows: Array<{
      _id: string;
      type: string;
      borrowerId: string | null;
      amount: number;
      sessionId: string | null;
      txHash: string | null;
      locusTransactionId: string | null;
      status: string;
      loanId: string | null;
      createdAt: string;
    }>;
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  }> {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.borrowerId) qs.set("borrowerId", params.borrowerId);
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    const raw = await jsonRequest<{
      transactions: Array<{
        _id: string;
        type: string;
        borrowerId: string | null;
        amount: number;
        sessionId: string | null;
        txHash: string | null;
        locusTransactionId: string | null;
        status: string;
        loanId: string | null;
        createdAt: string;
      }>;
      pagination: {
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      };
    }>(`${CREDIT_BASE}/transactions${query ? `?${query}` : ""}`);
    return { rows: raw.transactions, ...raw.pagination };
  },

  getAgent(borrowerId: string): Promise<{
    borrower: BorrowerRow & {
      serviceUrl?: string;
      apiKeyPrefix?: string | null;
    };
    recentLoans: LoanRow[];
    totals: {
      lifetimeBorrowed: number;
      lifetimeRepaid: number;
      lifetimeDefaulted: number;
      openLoanCount: number;
    };
  }> {
    return jsonRequest(
      `${CREDIT_BASE}/agents/${encodeURIComponent(borrowerId)}`,
    );
  },

  getAgentBalance(borrowerId: string): Promise<{
    borrowerId: string;
    walletAddress: string;
    usdcBalance: number;
    promoBalance: number;
    chain: string;
    fetchedAt: string;
    cached: boolean;
  }> {
    return jsonRequest(
      `${CREDIT_BASE}/agents/${encodeURIComponent(borrowerId)}/balance`,
    );
  },

  getStats(): Promise<{
    loansToday: number;
    loansFundedTotal: number;
    defaultRate24h: number;
    defaultRateTotal: number;
    volumeUsdcSettled: number;
    activeBorrowers: number;
    openLoans: number;
    lastEventAt: string | null;
  }> {
    return jsonRequest(`${CREDIT_BASE}/stats`);
  },

  getScoreEvents(
    wallet: string,
    limit?: number,
  ): Promise<
    Array<{ type: string; delta: number; reason: string; createdAt: string }>
  > {
    const qs = limit ? `?limit=${limit}` : "";
    return jsonRequest(
      `${CREDIT_BASE}/score/${encodeURIComponent(wallet)}/events${qs}`,
    );
  },

  resetDemo(): Promise<{
    ok: true;
    cleared: Record<string, number>;
  }> {
    return jsonRequest(`${CREDIT_BASE}/debug/reset-demo`, { method: "POST" });
  },

  simulatePay(sessionId: string): Promise<{
    ok: true;
    sessionId: string;
    status: string;
    paymentTxHash: string;
  }> {
    return jsonRequest(`${CREDIT_BASE}/debug/simulate-pay`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  },

  getLoanSessions(loanId: string): Promise<{
    loanId: string;
    disbursement: { sessionId: string; status: string; txHash: string | null } | null;
    repayment: { sessionId: string; status: string; txHash: string | null } | null;
    customer: { sessionId: string; status: string; txHash: string | null } | null;
  }> {
    return jsonRequest(
      `${CREDIT_BASE}/loans/${encodeURIComponent(loanId)}/sessions`,
    );
  },

  getAgentBalanceForce(borrowerId: string): Promise<{
    borrowerId: string;
    walletAddress: string;
    usdcBalance: number;
    promoBalance: number;
    chain: string;
    fetchedAt: string;
    cached: boolean;
  }> {
    return jsonRequest(
      `${CREDIT_BASE}/agents/${encodeURIComponent(borrowerId)}/balance?force=1`,
    );
  },

  // Already implemented routes
  draw(input: {
    borrowerId: string;
    amount: number;
    purpose: string;
    ttl: number;
  }): Promise<DrawApprovedResponse> {
    return jsonRequest(`${CREDIT_BASE}/credit/draw`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  fund(input: {
    decisionToken: string;
    targetSessionId: string;
  }): Promise<FundResponse> {
    return jsonRequest(`${CREDIT_BASE}/credit/fund`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};

// ── customer-agent ──────────────────────────────────────────────────────

export const customer = {
  trigger(input: {
    borrowerId: "agent-a" | "agent-b";
    url?: string;
  }): Promise<TriggerResult> {
    return jsonRequest(`${CUSTOMER_BASE}/trigger`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};

export const URLS = {
  credit: CREDIT_BASE,
  customer: CUSTOMER_BASE,
};
