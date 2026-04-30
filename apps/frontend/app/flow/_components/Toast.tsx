"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

export interface ToastMessage {
  id: number;
  text: string;
  variant?: "info" | "warn" | "danger" | "accent";
}

const VARIANT_CLS: Record<NonNullable<ToastMessage["variant"]>, string> = {
  info: "bg-info-soft border-info/40 text-info",
  warn: "bg-warn-soft border-warn/40 text-warn",
  danger: "bg-danger-soft border-danger/40 text-danger",
  accent: "bg-accent-soft border-accent/40 text-accent",
};

const VARIANT_ICON: Record<NonNullable<ToastMessage["variant"]>, string> = {
  info: "ℹ",
  warn: "⚠",
  danger: "✕",
  accent: "✓",
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 max-w-lg w-[calc(100%-2rem)] pointer-events-none"
      style={{ top: 88 }}
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 4000);
    return () => clearTimeout(t);
  }, [toast.id, onDismiss]);

  const variant = toast.variant ?? "info";
  const cls = VARIANT_CLS[variant];
  return (
    <div
      className={`px-4 py-3 rounded-xl border backdrop-blur-md shadow-lg flex items-start gap-3 ${cls}`}
    >
      <span className="text-base leading-none mt-0.5" aria-hidden>
        {VARIANT_ICON[variant]}
      </span>
      <div className="flex-1 text-sm leading-relaxed font-medium break-words">
        {toast.text}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-current opacity-60 hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
