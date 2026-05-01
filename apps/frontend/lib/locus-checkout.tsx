"use client";

// Thin wrapper around @withlocus/checkout-react. The SDK accepts a
// `checkoutUrl` prop (default `https://checkout.paywithlocus.com`) and
// uses its origin to mount the iframe. Beta sessions live on a
// different origin — `https://beta-checkout.paywithlocus.com` — so
// without an override the iframe loads the production checkout app
// which then 404s when its internal call to
// `https://api.paywithlocus.com/api/checkout/public/:id` doesn't find
// the beta session.
//
// Resolution order for the SDK's `checkoutUrl`:
//   1. Explicit `checkoutUrl` prop (typically the per-session URL
//      Locus returned at create time and we now persist on the task
//      as `escrowCheckoutUrl`).
//   2. `NEXT_PUBLIC_LOCUS_CHECKOUT_URL` env var (a sensible default
//      origin for the workspace — e.g. `https://beta-checkout.…`).
//   3. The SDK's hardcoded production default.

import { LocusCheckout, type CheckoutSuccessData } from "@withlocus/checkout-react";

const DEFAULT_CHECKOUT_BASE =
  process.env.NEXT_PUBLIC_LOCUS_CHECKOUT_URL ??
  "https://beta-checkout.paywithlocus.com";

export interface LocusCheckoutMountProps {
  sessionId: string;
  /** Per-session checkout URL returned by Locus at create time. Falls
   *  back to the default base origin if absent. */
  checkoutUrl?: string | null;
  onPaid?: (data: CheckoutSuccessData) => void;
  onError?: (err: Error) => void;
  onCancel?: () => void;
  mode?: "embedded" | "popup" | "redirect";
}

export function LocusCheckoutMount({
  sessionId,
  checkoutUrl,
  onPaid,
  onError,
  onCancel,
  mode = "embedded",
}: LocusCheckoutMountProps) {
  const resolved = checkoutUrl ?? DEFAULT_CHECKOUT_BASE;
  return (
    <div className="bg-white rounded-md overflow-hidden">
      <LocusCheckout
        sessionId={sessionId}
        checkoutUrl={resolved}
        mode={mode}
        onSuccess={(data) => onPaid?.(data)}
        onCancel={() => onCancel?.()}
        onError={(err) => onError?.(err)}
      />
    </div>
  );
}

export type { CheckoutSuccessData };
