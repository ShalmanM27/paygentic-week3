"use client";

import { useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  ConnectionDot,
  Section,
  USDC,
} from "../../components/ui";
import { useCreditEvents } from "../../lib/sse";
import { credit, customer } from "../../lib/credit-client";
import {
  buildFlowSnapshot,
  EMPTY_SNAPSHOT,
  type FlowSnapshot,
} from "./_components/card-states";
import {
  ApprovedCardContent,
  CommittedCardContent,
  FlowCard,
  FundedCardContent,
  RepaidCardContent,
  RequestCardContent,
} from "./_components/FlowCard";
import { RawJsonConsole } from "./_components/RawJsonConsole";
import { SessionTriad } from "./_components/SessionTriad";
import { ToastStack, type ToastMessage } from "./_components/Toast";

export default function FlowPage() {
  const { events, connected, lastHeartbeatAt } = useCreditEvents();
  const [triggeredAt, setTriggeredAt] = useState<number | null>(null);
  const [triggerCustomerSessionId, setTriggerCustomerSessionId] =
    useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastIdRef = useRef(0);

  const snapshot: FlowSnapshot = useMemo(() => {
    if (triggeredAt === null) return EMPTY_SNAPSHOT;
    return buildFlowSnapshot({
      events,
      triggeredAt,
      triggerCustomerSessionId,
    });
  }, [events, triggeredAt, triggerCustomerSessionId]);

  function pushToast(text: string, variant: ToastMessage["variant"] = "info") {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, variant }]);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  async function runLoan(borrowerId: "agent-a" | "agent-b") {
    if (busy) return;
    setBusy(true);
    setTriggeredAt(Date.now());
    setTriggerCustomerSessionId(null);
    pushToast(
      borrowerId === "agent-a"
        ? "Triggered customer payment to agent-a…"
        : "Triggered customer payment to agent-b — watching for default…",
      borrowerId === "agent-a" ? "info" : "warn",
    );
    try {
      const res = await customer.trigger({
        borrowerId,
        url: "https://example.com/article",
      });
      setTriggerCustomerSessionId(res.sessionId);
      pushToast(`/trigger ok — session ${res.sessionId.slice(0, 14)}…`, "accent");
    } catch (err) {
      pushToast(
        `trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
      setTriggeredAt(null);
    } finally {
      setBusy(false);
    }
  }

  async function resetDemo() {
    if (busy) return;
    if (
      !window.confirm(
        "Clear all loans, transactions, and reset scores? Borrower wallets on Locus are NOT touched.",
      )
    )
      return;
    setBusy(true);
    setTriggeredAt(null);
    setTriggerCustomerSessionId(null);
    try {
      const res = await credit.resetDemo();
      const counts = Object.entries(res.cleared)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      pushToast(`reset ok — cleared ${counts}`, "accent");
    } catch (err) {
      pushToast(
        `reset failed: ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }

  // Card status for the SessionTriad
  const customerStatus =
    snapshot.activeLoanId !== null
      ? snapshot.cards[2].status === "DONE" ||
        snapshot.cards[2].status === "ACTIVE"
        ? "PAID"
        : "PENDING"
      : null;
  const targetStatus =
    snapshot.cards[2].status === "DONE"
      ? "PAID"
      : snapshot.cards[2].status === "ACTIVE"
        ? "PENDING"
        : null;
  const repaymentStatus =
    snapshot.cards[4].status === "DONE"
      ? "PAID"
      : snapshot.cards[4].status === "FAILED"
        ? "EXPIRED"
        : snapshot.cards[3].status === "ACTIVE" ||
            snapshot.cards[3].status === "DONE"
          ? "PENDING"
          : null;

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-panel-border pb-4 mb-6">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono-tight text-xl font-semibold tracking-tight">
            CREDIT
          </h1>
          <span className="text-ink-dim text-sm">— Live Loan Flow</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-dim ml-2">
            <ConnectionDot connected={connected} pulsing={!!lastHeartbeatAt} />
            {connected ? "live" : "disconnected"}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => runLoan("agent-a")}
          >
            ▶ Run Loan (Borrower A)
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => runLoan("agent-b")}
          >
            ⚠ Trigger Default (B)
          </Button>
          <Button variant="secondary" disabled={busy} onClick={resetDemo}>
            ↻ Reset Demo
          </Button>
        </div>
      </header>

      {/* 5 cards */}
      <Section
        title="Loan lifecycle"
        rightSlot={
          snapshot.activeLoanId ? (
            <span className="text-xs font-mono-tight text-ink-dim">
              loanId{" "}
              <span className="text-accent">{snapshot.activeLoanId}</span>
            </span>
          ) : null
        }
      >
        <div className="flex gap-3">
          <FlowCard
            index={1}
            total={5}
            name="REQUEST"
            status={snapshot.cards[0].status}
            icon="⚡"
          >
            <RequestCardContent
              triggeredAt={
                (snapshot.cards[0].data.triggeredAt as number | undefined) ??
                triggeredAt
              }
            />
          </FlowCard>
          <FlowCard
            index={2}
            total={5}
            name="APPROVED"
            status={snapshot.cards[1].status}
            icon="✓"
          >
            <ApprovedCardContent
              loanId={snapshot.cards[1].data.loanId as string | undefined}
              amount={snapshot.cards[1].data.amount as number | undefined}
              rate={snapshot.cards[1].data.rate as number | undefined}
              repayAmount={snapshot.cards[1].data.repayAmount as number | undefined}
            />
          </FlowCard>
          <FlowCard
            index={3}
            total={5}
            name="FUNDED"
            status={snapshot.cards[2].status}
            icon="◆"
          >
            <FundedCardContent
              txHash={snapshot.cards[2].data.txHash as string | null | undefined}
              dueAt={snapshot.cards[2].data.dueAt as string | undefined}
            />
          </FlowCard>
          <FlowCard
            index={4}
            total={5}
            name="COMMITTED"
            status={snapshot.cards[3].status}
            icon="⏱"
          >
            <CommittedCardContent
              status={snapshot.cards[3].status}
              repaymentSessionId={
                snapshot.cards[3].data.repaymentSessionId as string | undefined
              }
              reason={snapshot.cards[3].data.reason as string | undefined}
            />
          </FlowCard>
          <FlowCard
            index={5}
            total={5}
            name="REPAID"
            status={snapshot.cards[4].status}
            icon="🔒"
          >
            <RepaidCardContent
              status={snapshot.cards[4].status}
              txHash={snapshot.cards[4].data.txHash as string | null | undefined}
              reason={snapshot.cards[4].data.reason as string | undefined}
            />
          </FlowCard>
        </div>
      </Section>

      {/* Console */}
      <div className="mt-8">
        <Section title="Activity console">
          <RawJsonConsole events={events} />
        </Section>
      </div>

      {/* Session Triad */}
      <div className="mt-8">
        <Section title="Locus session triad">
          <SessionTriad
            customerSessionId={snapshot.customerSessionId}
            targetSessionId={snapshot.targetSessionId}
            repaymentSessionId={snapshot.repaymentSessionId}
            customerStatus={customerStatus}
            targetStatus={targetStatus}
            repaymentStatus={repaymentStatus}
          />
        </Section>
      </div>

      {/* Footer hint */}
      <div className="mt-12 text-center text-ink-dimmer text-xs font-mono-tight">
        SSE: {events.length} buffered events · last heartbeat{" "}
        {lastHeartbeatAt
          ? `${Math.round((Date.now() - lastHeartbeatAt) / 1000)}s ago`
          : "—"}
      </div>
    </main>
  );
}

void Card;
void USDC;
