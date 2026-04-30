// Shared test helper: build, sign, and POST a synthesized Locus webhook.
// Used by Phase 3 (test-webhook-flow), Phase 5 (test-borrow-flow), and
// Phase 7 (test-e2e-loop). Single source of truth for webhook synthesis.

import { createHmac } from "node:crypto";

export interface WebhookEnvelope {
  type: "checkout.session.paid" | "checkout.session.expired";
  data: { sessionId: string; [k: string]: unknown };
}

export interface PostedWebhook {
  status: number;
  json: unknown;
  body: string;
  signature: string;
}

export function signWebhook(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function buildSignedWebhook(
  envelope: WebhookEnvelope,
  secret: string,
): { body: string; signature: string } {
  const body = JSON.stringify(envelope);
  return { body, signature: signWebhook(body, secret) };
}

export async function postSignedWebhook(args: {
  url: string;
  envelope: WebhookEnvelope;
  secret: string;
}): Promise<PostedWebhook> {
  const { body, signature } = buildSignedWebhook(args.envelope, args.secret);
  const res = await fetch(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-locus-signature": signature,
    },
    body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = { _nonjson: text };
  }
  return { status: res.status, json, body, signature };
}
