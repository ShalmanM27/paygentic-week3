"use client";

import { Card, SessionId, StatusPill } from "../../../components/ui";

interface TriadProps {
  customerSessionId: string | null;
  targetSessionId: string | null;
  repaymentSessionId: string | null;
  customerStatus: string | null;
  targetStatus: string | null;
  repaymentStatus: string | null;
}

export function SessionTriad({
  customerSessionId,
  targetSessionId,
  repaymentSessionId,
  customerStatus,
  targetStatus,
  repaymentStatus,
}: TriadProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <SessionCard
        title="Customer revenue"
        subtitle="customer pays borrower"
        sessionId={customerSessionId}
        status={customerStatus}
      />
      <SessionCard
        title="Disbursement"
        subtitle="credit funds borrower's cost"
        sessionId={targetSessionId}
        status={targetStatus}
      />
      <SessionCard
        title="Repayment"
        subtitle="borrower repays credit"
        sessionId={repaymentSessionId}
        status={repaymentStatus}
      />
    </div>
  );
}

function SessionCard({
  title,
  subtitle,
  sessionId,
  status,
}: {
  title: string;
  subtitle: string;
  sessionId: string | null;
  status: string | null;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim font-mono-tight">
            {title}
          </div>
          <div className="text-[11px] text-ink-dimmer">{subtitle}</div>
        </div>
        {status ? <StatusPill status={status} /> : (
          <span className="text-[10px] text-ink-dimmer font-mono-tight">
            —
          </span>
        )}
      </div>
      <div className="mt-2 pt-2 border-t border-panel-border">
        {sessionId ? (
          <SessionId id={sessionId} truncate />
        ) : (
          <span className="text-xs text-ink-dimmer font-mono-tight">
            session not yet created
          </span>
        )}
      </div>
    </Card>
  );
}
