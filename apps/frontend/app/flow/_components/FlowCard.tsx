"use client";

import type { ReactNode } from "react";
import type { CardStatus } from "./card-states";
import { TxHash, USDC } from "../../../components/ui";

interface FlowCardProps {
  index: number; // 1..5
  total: number; // 5
  name: string;
  status: CardStatus;
  icon: ReactNode;
  children: ReactNode;
}

const STATUS_CLS: Record<CardStatus, string> = {
  WAITING:
    "border-panel-border bg-panel-card text-ink-dimmer",
  ACTIVE:
    "border-accent/60 bg-panel-card text-ink animate-pulse-slow shadow-[0_0_24px_rgba(0,217,160,0.15)]",
  DONE:
    "border-accent bg-accent-soft text-ink",
  FAILED:
    "border-danger bg-danger-soft text-ink",
};

export function FlowCard({
  index,
  total,
  name,
  status,
  icon,
  children,
}: FlowCardProps) {
  return (
    <div
      className={`flex-1 min-w-0 rounded-md border transition-all duration-300 ${STATUS_CLS[status]} p-4 relative h-44`}
    >
      <div className="flex items-baseline justify-between mb-3">
        <span className="text-[10px] font-mono-tight uppercase tracking-widest text-ink-dimmer">
          {index}/{total}
        </span>
        <span className="text-ink-dimmer opacity-60 text-sm">{icon}</span>
      </div>
      <div className="font-mono-tight text-[11px] uppercase tracking-wider text-ink-dim mb-2">
        {name}
      </div>
      <div className="space-y-1 text-sm font-mono-tight">{children}</div>
    </div>
  );
}

// ── Specific card content components ─────────────────────────────────

export function RequestCardContent({
  triggeredAt,
}: {
  triggeredAt: number | null;
}) {
  if (triggeredAt === null) {
    return <div className="text-ink-dimmer text-xs">awaiting trigger</div>;
  }
  return (
    <>
      <div className="text-ink text-xs">customer-agent → /work</div>
      <div className="text-ink-dim text-xs">
        {new Date(triggeredAt).toLocaleTimeString()}
      </div>
    </>
  );
}

export function ApprovedCardContent({
  loanId,
  amount,
  rate,
  repayAmount,
}: {
  loanId?: string;
  amount?: number;
  rate?: number;
  repayAmount?: number;
}) {
  if (!loanId) {
    return <div className="text-ink-dimmer text-xs">awaiting approval…</div>;
  }
  return (
    <>
      <div className="text-ink truncate" title={loanId}>
        <span className="text-ink-dim">loanId </span>
        <span className="text-accent">{loanId}</span>
      </div>
      <div className="text-xs text-ink-dim">
        <USDC amount={amount ?? 0} /> @{" "}
        <span className="text-warn">{((rate ?? 0) * 100).toFixed(0)}%</span>
      </div>
      <div className="text-xs text-ink-dim">
        repay <USDC amount={repayAmount ?? 0} />
      </div>
    </>
  );
}

export function FundedCardContent({
  txHash,
  dueAt,
}: {
  txHash?: string | null;
  dueAt?: string;
}) {
  if (txHash === undefined && dueAt === undefined) {
    return <div className="text-ink-dimmer text-xs">awaiting disbursement…</div>;
  }
  return (
    <>
      <div className="text-xs">
        <span className="text-ink-dim">tx </span>
        <TxHash hash={txHash ?? null} />
      </div>
      {dueAt && (
        <div className="text-xs text-ink-dim">
          due {new Date(dueAt).toLocaleTimeString()}
        </div>
      )}
    </>
  );
}

export function CommittedCardContent({
  repaymentSessionId,
  reason,
  status,
}: {
  repaymentSessionId?: string;
  reason?: string;
  status: CardStatus;
}) {
  if (status === "WAITING") {
    return (
      <div className="text-ink-dimmer text-xs">awaiting commit…</div>
    );
  }
  if (status === "FAILED") {
    return (
      <>
        <div className="text-danger text-xs uppercase">collection failed</div>
        {reason && <div className="text-ink-dim text-[11px]">{reason}</div>}
      </>
    );
  }
  return (
    <>
      <div className="text-xs text-ink-dim">repayment session</div>
      <div className="text-xs text-ink truncate" title={repaymentSessionId}>
        {repaymentSessionId ? `${repaymentSessionId.slice(0, 16)}…` : "—"}
      </div>
    </>
  );
}

export function RepaidCardContent({
  txHash,
  reason,
  status,
}: {
  txHash?: string | null;
  reason?: string;
  status: CardStatus;
}) {
  if (status === "WAITING") {
    return <div className="text-ink-dimmer text-xs">awaiting close…</div>;
  }
  if (status === "FAILED") {
    return (
      <>
        <div className="text-danger text-xs uppercase">DEFAULTED</div>
        {reason && <div className="text-ink-dim text-[11px]">{reason}</div>}
      </>
    );
  }
  return (
    <>
      <div className="text-xs">
        <span className="text-ink-dim">tx </span>
        <TxHash hash={txHash ?? null} />
      </div>
      <div className="text-xs text-accent uppercase tracking-wider">REPAID</div>
    </>
  );
}
