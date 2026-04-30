// In-memory ring buffer of every verified inbound webhook. Used by the
// gated /debug/last-webhook route to support live-webhook smoke tests.
//
// IMPORTANT: behind DEBUG_ENDPOINTS_ENABLED=1 — never expose in production.

export interface CapturedWebhook {
  receivedAt: string;
  signatureHeader: string | undefined;
  headers: Record<string, unknown>;
  rawBody: string;
  parsed: unknown;
}

const RING_SIZE = 10;
const ring: CapturedWebhook[] = [];

export function captureWebhook(entry: CapturedWebhook): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

export function recentWebhooks(): CapturedWebhook[] {
  return [...ring];
}

export function _resetWebhookCapture(): void {
  ring.length = 0;
}
