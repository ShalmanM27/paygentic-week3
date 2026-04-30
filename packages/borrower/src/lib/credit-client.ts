// Thin HTTP client for the Credit Agent. Used by the borrower to register
// itself, draw a decision token, and fund a target session.

import { request } from "undici";

export interface RegisterParams {
  borrowerId: string;
  walletAddress: string;
  serviceUrl: string;
  registrationApiKey: string;
}

export interface DrawParams {
  borrowerId: string;
  amount: number;
  purpose: string;
  ttl: number;
  /** Optional escrow-task association — when set, the loan record's
   *  linkedTaskId is populated and the decision token carries it through
   *  to /credit/fund. */
  taskId?: string;
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

export interface DrawRejectedResponse {
  approved: false;
  reason: string;
  [k: string]: unknown;
}

export type DrawResponse = DrawApprovedResponse | DrawRejectedResponse;

export interface FundResponse {
  loanId: string;
  disbursement: { transactionId: string; txHash: string | null; status: string };
  repaymentSessionId: string;
  repayAmount: number;
  dueAt: string;
}

export class CreditClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async register(params: RegisterParams): Promise<{ ok: boolean; score: number; limit: number }> {
    return this.post("/credit/register", params);
  }

  async draw(params: DrawParams): Promise<DrawResponse> {
    return this.post("/credit/draw", params, true);
  }

  async fund(params: {
    decisionToken: string;
    targetSessionId: string;
  }): Promise<FundResponse> {
    return this.post("/credit/fund", params);
  }

  private async post<T>(path: string, body: unknown, allowError = false): Promise<T> {
    const res = await request(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.body.text();
    let parsed: unknown = {};
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new Error(`credit ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (res.statusCode >= 400 && !allowError) {
      throw new Error(
        `credit ${path} failed (${res.statusCode}): ${JSON.stringify(parsed)}`,
      );
    }
    return parsed as T;
  }
}
