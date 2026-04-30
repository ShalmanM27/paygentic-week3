"use client";

import { useEffect } from "react";

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

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
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

  const cls = VARIANT_CLS[toast.variant ?? "info"];
  return (
    <div
      className={`px-3 py-2 rounded border font-mono-tight text-sm shadow-lg ${cls}`}
    >
      {toast.text}
    </div>
  );
}
