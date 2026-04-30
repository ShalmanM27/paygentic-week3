// HMAC-SHA256 decision tokens. 60s TTL by default.
// Format: `${payloadB64url}.${signatureB64url}`
// Payload JSON: { borrowerId, amount, rate, expiresAt }

import { createHmac, timingSafeEqual } from "node:crypto";

export interface DecisionPayload {
  borrowerId: string;
  amount: number;
  rate: number;
  ttlSeconds: number;
  /** ISO timestamp string. Token rejected after this instant. */
  expiresAt: string;
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(norm, "base64");
}

function sigFor(payloadB64: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(payloadB64).digest();
  return b64urlEncode(mac);
}

export function sign(payload: DecisionPayload, secret: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sigFor(payloadB64, secret)}`;
}

export type VerifyResult =
  | { ok: true; payload: DecisionPayload }
  | { ok: false; reason: string };

export function verify(token: string, secret: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed_token" };
  const [payloadB64, providedSig] = parts as [string, string];

  const expected = sigFor(payloadB64, secret);
  const a = b64urlDecode(providedSig);
  const b = b64urlDecode(expected);
  if (a.length !== b.length) return { ok: false, reason: "signature_mismatch" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };

  let payload: DecisionPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "payload_not_json" };
  }
  if (
    typeof payload.borrowerId !== "string" ||
    typeof payload.amount !== "number" ||
    typeof payload.rate !== "number" ||
    typeof payload.ttlSeconds !== "number" ||
    typeof payload.expiresAt !== "string"
  ) {
    return { ok: false, reason: "payload_shape_invalid" };
  }
  if (Date.now() >= Date.parse(payload.expiresAt)) {
    return { ok: false, reason: "token_expired" };
  }
  return { ok: true, payload };
}
