// Thin HTTP wrapper over the Locus beta API.
// One method per endpoint; no retries, no logging, no DB. Pure I/O.

import { request } from "undici";
import type {
  AgentPayResponse,
  CheckoutSession,
  CreateSessionParams,
  PaymentStatus,
  PreflightResponse,
  SendUsdcResponse,
  WalletBalance,
} from "./types.js";

const DEFAULT_API_BASE = "https://beta-api.paywithlocus.com/api";

export interface LocusClientOptions {
  apiKey: string;
  apiBase?: string;
}

export interface LocusApiErrorPayload {
  status: number;
  error: string;
  message: string;
  endpoint: string;
}

export class LocusApiError extends Error {
  public readonly status: number;
  public readonly error: string;
  public readonly endpoint: string;

  constructor(payload: LocusApiErrorPayload) {
    super(`[${payload.status} ${payload.error}] ${payload.endpoint}: ${payload.message}`);
    this.name = "LocusApiError";
    this.status = payload.status;
    this.error = payload.error;
    this.endpoint = payload.endpoint;
  }
}

type Method = "GET" | "POST";

export class LocusClient {
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(opts: LocusClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  }

  // ── Wallet ────────────────────────────────────────────────────────────

  async balance(): Promise<WalletBalance> {
    return this.call<WalletBalance>("GET", "/pay/balance");
  }

  async send(params: {
    toAddress: string;
    amount: number;
    memo: string;
  }): Promise<SendUsdcResponse> {
    return this.call<SendUsdcResponse>("POST", "/pay/send", {
      to_address: params.toAddress,
      amount: params.amount,
      memo: params.memo,
    });
  }

  // ── Checkout (merchant side) ─────────────────────────────────────────

  async createSession(params: CreateSessionParams): Promise<CheckoutSession> {
    return this.call<CheckoutSession>("POST", "/checkout/sessions", params);
  }

  async getSession(sessionId: string): Promise<CheckoutSession> {
    return this.call<CheckoutSession>(
      "GET",
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  // ── Checkout (agent side) ────────────────────────────────────────────

  async preflight(sessionId: string): Promise<PreflightResponse> {
    return this.call<PreflightResponse>(
      "GET",
      `/checkout/agent/preflight/${encodeURIComponent(sessionId)}`,
    );
  }

  async agentPay(
    sessionId: string,
    opts?: { payerEmail?: string },
  ): Promise<AgentPayResponse> {
    const body =
      opts?.payerEmail !== undefined ? { payer_email: opts.payerEmail } : {};
    return this.call<AgentPayResponse>(
      "POST",
      `/checkout/agent/pay/${encodeURIComponent(sessionId)}`,
      body,
    );
  }

  async getPayment(transactionId: string): Promise<PaymentStatus> {
    return this.call<PaymentStatus>(
      "GET",
      `/checkout/agent/payments/${encodeURIComponent(transactionId)}`,
    );
  }

  /**
   * Polls `GET /checkout/sessions/:sessionId` until the status reaches a
   * terminal value (PAID, EXPIRED, CANCELLED). This is the BETA-CORRECT
   * confirmation path because:
   *   - `/checkout/agent/payments/:id` is broken in beta (403)
   *   - Webhooks are not implemented in beta
   *   - `getSession` works and returns `paymentTxHash` once PAID
   *
   * Polls every 2s with ±200ms jitter. Throws on timeout.
   */
  async waitForSessionSettled(
    sessionId: string,
    timeoutMs: number = 60_000,
  ): Promise<CheckoutSession> {
    const TERMINAL = new Set(["PAID", "EXPIRED", "CANCELLED"]);
    const deadline = Date.now() + timeoutMs;
    const baseInterval = 2000;
    while (Date.now() < deadline) {
      const session = await this.getSession(sessionId);
      if (TERMINAL.has(String(session.status).toUpperCase())) {
        return session;
      }
      const jitter = Math.floor(Math.random() * 401) - 200;
      await sleep(baseInterval + jitter);
    }
    throw new LocusApiError({
      status: 0,
      error: "timeout",
      message: `waitForSessionSettled timed out after ${timeoutMs}ms`,
      endpoint: `/checkout/sessions/${sessionId}`,
    });
  }

  /**
   * @deprecated In beta the `/checkout/agent/payments/:id` endpoint
   * returns 403 even for the agent that initiated the payment, and the
   * list endpoint returns empty for genuinely-initiated transactions
   * that BaseScan confirms settled. Use {@link waitForSessionSettled}
   * instead — Locus team confirmed `getSession` polling is the
   * canonical beta confirmation path. Kept for production where this
   * endpoint may work; not used in any code path today.
   */
  async waitForConfirm(
    transactionId: string,
    timeoutMs: number,
  ): Promise<PaymentStatus> {
    // Locus returns lowercase status on /checkout/agent/pay; case TBD on
    // /checkout/agent/payments. Match both; collapse once confirmed.
    const TERMINAL = new Set([
      "confirmed",
      "failed",
      "policy_rejected",
      "CONFIRMED",
      "FAILED",
      "POLICY_REJECTED",
    ]);
    const deadline = Date.now() + timeoutMs;
    const baseInterval = 2000;
    while (Date.now() < deadline) {
      const status = await this.getPayment(transactionId);
      if (TERMINAL.has(status.status as string)) {
        return status;
      }
      const jitter = Math.floor(Math.random() * 401) - 200; // [-200, +200]
      await sleep(baseInterval + jitter);
    }
    throw new LocusApiError({
      status: 0,
      error: "timeout",
      message: `waitForConfirm timed out after ${timeoutMs}ms`,
      endpoint: `/checkout/agent/payments/${transactionId}`,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async call<T>(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    let statusCode: number;
    let raw: string;
    try {
      const res = await request(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      statusCode = res.statusCode;
      raw = await res.body.text();
    } catch (err) {
      throw new LocusApiError({
        status: 0,
        error: "network_error",
        message: err instanceof Error ? err.message : String(err),
        endpoint: path,
      });
    }

    if (statusCode === 429) {
      throw new LocusApiError({
        status: 429,
        error: "rate_limited",
        message: "Too Many Requests — back off and retry",
        endpoint: path,
      });
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      throw new LocusApiError({
        status: statusCode,
        error: "invalid_json",
        message: `Non-JSON response: ${raw.slice(0, 200)}`,
        endpoint: path,
      });
    }

    // Locus uses TWO envelope shapes across the platform:
    //   wrapped: { success: true, data: { ... } }              (e.g. /pay/balance, /checkout/sessions)
    //   flat:    { success: true, canPay: true, agent: {...} } (e.g. /checkout/agent/preflight)
    // We accept both. 202 PENDING_APPROVAL on send/agentPay rides through
    // either path without throwing.

    if (typeof parsed !== "object" || parsed === null) {
      if (statusCode >= 200 && statusCode < 300) {
        return parsed as T;
      }
      throw new LocusApiError({
        status: statusCode,
        error: "unexpected_response",
        message: raw.slice(0, 200),
        endpoint: path,
      });
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj["success"] === "boolean") {
      if (obj["success"] === false) {
        const errEnv = obj as { error?: unknown; message?: unknown };
        throw new LocusApiError({
          status: statusCode,
          error: typeof errEnv.error === "string" ? errEnv.error : "unknown_error",
          message:
            typeof errEnv.message === "string"
              ? errEnv.message
              : raw.slice(0, 200),
          endpoint: path,
        });
      }
      if ("data" in obj) {
        return obj["data"] as T;
      }
      // Flat envelope: strip success, return the rest.
      const { success: _success, ...rest } = obj;
      void _success;
      return rest as T;
    }

    // Not a Locus envelope at all — return as-is on success, error otherwise.
    if (statusCode >= 200 && statusCode < 300) {
      return parsed as T;
    }
    throw new LocusApiError({
      status: statusCode,
      error: "unexpected_response",
      message: raw.slice(0, 200),
      endpoint: path,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
