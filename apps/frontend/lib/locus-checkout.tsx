"use client";

// Thin wrapper around @withlocus/checkout-react. The SDK provides:
//   - <LocusCheckout sessionId onSuccess onCancel onError mode />
//   - useLocusCheckout() for popup/redirect modes
//
// We expose <LocusCheckoutMount sessionId onPaid /> with embedded mode by
// default, since /score-report is the in-page buyer flow.

import { LocusCheckout, type CheckoutSuccessData } from "@withlocus/checkout-react";

export interface LocusCheckoutMountProps {
  sessionId: string;
  onPaid?: (data: CheckoutSuccessData) => void;
  onError?: (err: Error) => void;
  onCancel?: () => void;
  mode?: "embedded" | "popup" | "redirect";
}

export function LocusCheckoutMount({
  sessionId,
  onPaid,
  onError,
  onCancel,
  mode = "embedded",
}: LocusCheckoutMountProps) {
  return (
    <div className="bg-white rounded-md overflow-hidden">
      <LocusCheckout
        sessionId={sessionId}
        mode={mode}
        onSuccess={(data) => onPaid?.(data)}
        onCancel={() => onCancel?.()}
        onError={(err) => onError?.(err)}
      />
    </div>
  );
}

export type { CheckoutSuccessData };
