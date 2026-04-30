// HMAC-SHA256 verification + light parsing for Locus webhook posts.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types.js";

export interface VerifyArgs {
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  secret: string;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

const SIG_PREFIX = "sha256=";

export function verifyWebhookSignature(args: VerifyArgs): VerifyResult {
  const { rawBody, signatureHeader, secret } = args;

  if (!signatureHeader || !signatureHeader.startsWith(SIG_PREFIX)) {
    return { valid: false, reason: "missing_or_malformed_signature" };
  }
  const providedHex = signatureHeader.slice(SIG_PREFIX.length).trim();
  if (!/^[0-9a-fA-F]+$/.test(providedHex) || providedHex.length % 2 !== 0) {
    return { valid: false, reason: "missing_or_malformed_signature" };
  }

  const bodyBuf =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expectedHex = createHmac("sha256", secret).update(bodyBuf).digest("hex");

  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");

  if (provided.length !== expected.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

export function parseWebhookEvent(rawBody: string): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("webhook body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("webhook body is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj["type"];
  const data = obj["data"];

  if (
    type !== "checkout.session.paid" &&
    type !== "checkout.session.expired"
  ) {
    throw new Error(`unsupported webhook type: ${String(type)}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("webhook data is missing or not an object");
  }
  const dataObj = data as Record<string, unknown>;
  if (typeof dataObj["sessionId"] !== "string") {
    throw new Error("webhook data.sessionId is missing");
  }

  return {
    type,
    data: dataObj as WebhookEvent["data"],
  };
}
