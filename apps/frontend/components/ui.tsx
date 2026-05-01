"use client";

// Reusable design primitives. Bloomberg-Terminal-ish: dense, mono where data,
// sans where prose. Dark theme.

import { useState, type ReactNode, type HTMLAttributes } from "react";

const BASESCAN_BASE = "https://basescan.org";

// ── StatusPill ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-warn-soft text-warn border-warn/40",
  REQUESTED: "bg-info-soft text-info border-info/40",
  FUNDED: "bg-info-soft text-info border-info/40",
  REPAID: "bg-accent-soft text-accent border-accent/40",
  COMPLETED: "bg-accent-soft text-accent border-accent/40",
  CONFIRMED: "bg-accent-soft text-accent border-accent/40",
  PAID: "bg-accent-soft text-accent border-accent/40",
  DEFAULTED: "bg-danger-soft text-danger border-danger/40",
  FAILED: "bg-danger-soft text-danger border-danger/40",
  EXPIRED: "bg-danger-soft text-danger border-danger/40",
  CANCELLED: "bg-panel-cardHover text-ink-dim border-panel-borderStrong",
  ATTEMPTING: "bg-info-soft text-info border-info/40",
  ATTEMPTING_SETTLED: "bg-info-soft text-info border-info/40",
  WAITING: "bg-panel-cardHover text-ink-dim border-panel-borderStrong",
  ACTIVE: "bg-accent-soft text-accent border-accent/40",
  SUSPENDED: "bg-warn-soft text-warn border-warn/40",
  UNKNOWN: "bg-warn-soft text-warn border-warn/40",
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  const key = (status ?? "UNKNOWN").toUpperCase();
  const cls = STATUS_STYLES[key] ?? STATUS_STYLES["UNKNOWN"]!;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium font-mono-tight border ${cls}`}
    >
      {key}
    </span>
  );
}

// ── TxHash ─────────────────────────────────────────────────────────────

export function TxHash({
  hash,
  truncate = true,
}: {
  hash: string | null | undefined;
  truncate?: boolean;
}) {
  if (!hash) {
    return (
      <span className="text-warn font-mono-tight text-xs animate-pulse-slow">
        settling…
      </span>
    );
  }
  const display = truncate ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
  const isMock = hash.startsWith("0xmock");
  return (
    <a
      href={isMock ? "#" : `${BASESCAN_BASE}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (isMock) e.preventDefault();
      }}
      className={`font-mono-tight text-xs ${isMock ? "text-ink-dimmer cursor-default" : "text-info hover:underline"}`}
      title={hash}
    >
      {display}
      {isMock && <span className="ml-1 text-[10px]">(mock)</span>}
    </a>
  );
}

// ── USDC ───────────────────────────────────────────────────────────────

export function USDC({
  amount,
  decimals = 4,
  className = "",
}: {
  amount: number | string | null | undefined;
  decimals?: number;
  className?: string;
}) {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return <span className={`font-mono-tight ${className}`}>—</span>;
  }
  return (
    <span className={`font-mono-tight tabular-nums ${className}`}>
      ${n.toFixed(decimals)}
    </span>
  );
}

// ── SessionId ──────────────────────────────────────────────────────────

export function SessionId({
  id,
  truncate = true,
}: {
  id: string | null | undefined;
  truncate?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!id) return <span className="text-ink-dimmer font-mono-tight">—</span>;
  const display = truncate ? `${id.slice(0, 12)}…` : id;
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="font-mono-tight text-xs text-ink-dim hover:text-accent transition-colors"
      title={`${id} (click to copy)`}
    >
      {copied ? "✓ copied" : display}
    </button>
  );
}

// ── Card / Section / Tag ───────────────────────────────────────────────

export function Card({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`bg-panel-card border border-panel-border rounded-md ${className}`}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  rightSlot,
  children,
}: {
  title?: ReactNode;
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {(title || rightSlot) && (
        <div className="flex items-baseline justify-between">
          {title && (
            <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim">
              {title}
            </h2>
          )}
          {rightSlot}
        </div>
      )}
      {children}
    </div>
  );
}

export function Tag({
  children,
  variant = "default",
  className = "",
}: {
  children: ReactNode;
  variant?: "default" | "accent" | "warn" | "danger" | "info";
  className?: string;
}) {
  const variants: Record<string, string> = {
    default: "bg-panel-cardHover text-ink-dim border-panel-border",
    accent: "bg-accent-soft text-accent border-accent/40",
    warn: "bg-warn-soft text-warn border-warn/40",
    danger: "bg-danger-soft text-danger border-danger/40",
    info: "bg-info-soft text-info border-info/40",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium font-mono-tight border ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}

// ── ConnectionDot ──────────────────────────────────────────────────────

export function ConnectionDot({
  connected,
  pulsing = false,
}: {
  connected: boolean;
  pulsing?: boolean;
}) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        connected ? "bg-accent" : "bg-danger"
      } ${pulsing ? "animate-pulse" : ""}`}
    />
  );
}

// ── Button ─────────────────────────────────────────────────────────────

// ── Skeleton ──────────────────────────────────────────────────────────
// Pulsing placeholder bar. Use as a building block while data loads.
// Pure CSS animation (no Framer Motion needed) for max idle perf.
export function Skeleton({
  className = "",
  rounded = "md",
}: {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
}) {
  const r =
    rounded === "full"
      ? "rounded-full"
      : rounded === "lg"
        ? "rounded-xl"
        : rounded === "sm"
          ? "rounded"
          : "rounded-md";
  return (
    <div
      className={`relative overflow-hidden bg-white/[0.04] ${r} ${className}`}
      aria-hidden
    >
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-skeleton-shimmer" />
    </div>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  children,
  className = "",
  ...rest
}: {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  className?: string;
} & HTMLAttributes<HTMLButtonElement> & {
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }) {
  const variants: Record<string, string> = {
    primary:
      "bg-accent text-black hover:bg-accent-dim disabled:bg-accent/40 disabled:text-black/60",
    secondary:
      "bg-panel-cardHover text-ink border border-panel-borderStrong hover:bg-panel-border",
    danger:
      "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
    ghost: "text-ink-dim hover:text-ink",
  };
  const sizes: Record<string, string> = {
    sm: "px-2 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
    lg: "px-4 py-2 text-base",
  };
  return (
    <button
      {...rest}
      className={`font-medium rounded transition-colors disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}
