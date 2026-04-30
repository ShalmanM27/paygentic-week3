"use client";

// V3 /flow page. Three pillars of the same story:
//   - LEFT (60%): animated MoneyFlowGraph (real coin orbs, real hashes)
//   - RIGHT (40%): TransactionChecklist (persistent step-by-step)
//   - BELOW (full width): 5-card lifecycle strip (legacy familiar view)

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { useCreditEvents } from "../../lib/sse";
import { credit } from "../../lib/credit-client";
import {
  MoneyFlowGraph,
  type NodeBadge,
} from "./_components/MoneyFlowGraph";
import {
  TransactionChecklist,
  type ChecklistMode,
} from "./_components/TransactionChecklist";
import { ToastStack, type ToastMessage } from "./_components/Toast";
import { PageHeader } from "../../components/PageHeader";
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

export default function FlowPage() {
  const { events } = useCreditEvents();
  const [triggeredBorrowerId, setTriggeredBorrowerId] = useState<string | null>(
    null,
  );
  const [triggerToken, setTriggerToken] = useState(0);
  const [triggerStartedAt, setTriggerStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [triggerCustomerSessionId, setTriggerCustomerSessionId] =
    useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeLoanId, setActiveLoanId] = useState<string | null>(null);
  // Controlled badges, keyed by NodeId. Reset Demo clears this map.
  // Only events for the CURRENT activeTaskId / activeLoanId can update
  // it, so badges from prior runs never bleed in.
  const [nodeBadges, setNodeBadges] = useState<
    Partial<Record<string, NodeBadge | null>>
  >({});
  const [scoreFlashNode, setScoreFlashNode] = useState<string | null>(null);
  const toastIdRef = useRef(0);

  const checklistMode: ChecklistMode =
    triggerToken === 0
      ? "idle"
      : triggeredBorrowerId === "agent-b"
        ? "default"
        : "happy";

  const snapshot: FlowSnapshot = useMemo(() => {
    if (triggerStartedAt === null) return EMPTY_SNAPSHOT;
    return buildFlowSnapshot({
      events,
      triggeredAt: triggerStartedAt,
      triggerCustomerSessionId,
    });
  }, [events, triggerStartedAt, triggerCustomerSessionId]);

  function pushToast(text: string, variant: ToastMessage["variant"] = "info") {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, variant }]);
  }
  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // V3.1 — /flow now exercises the FULL escrow path (createTask →
  // simulate-pay → escrow-watcher dispatches → agent borrows → does
  // work → loan repays → credit releases escrow). Same backend the
  // marketplace uses, so all task.* + loan.* SSE events fire.
  async function runLoan(borrowerId: "agent-a" | "agent-b") {
    if (busy) return;
    setBusy(true);
    setTriggeredBorrowerId(borrowerId);
    setTriggerStartedAt(Date.now());
    setTriggerCustomerSessionId(null);
    setTriggerToken((n) => n + 1);
    pushToast(
      borrowerId === "agent-a"
        ? "Triggered happy path — watch the orbs"
        : "Triggered default — watch the auto-refund",
      borrowerId === "agent-a" ? "accent" : "warn",
    );
    const agentId = borrowerId === "agent-a" ? "summarizer" : "code-reviewer";
    const input =
      borrowerId === "agent-a"
        ? "Demo: explain how agent escrow works in 2 sentences"
        : "Demo: explain why this borrower will default in 2 sentences";
    try {
      const created = await credit.createTask({
        agentId,
        input,
        userIdentifier: "demo-flow-page",
      });
      setTriggerCustomerSessionId(created.sessionId);
      setActiveTaskId(created.task.taskId);
      setActiveLoanId(null);
      // Optimistically show "holding escrow" — escrow-watcher will
      // confirm via task.escrow_paid within ~3s and we'll re-set
      // it from the event payload.
      setNodeBadges({ credit: { type: "holding", amount: 0.008 } });
      // Simulate the user paying the escrow session — escrow-watcher
      // will pick it up within 3s and drive the rest of the flow.
      await credit.simulatePay(created.sessionId);
    } catch (err) {
      pushToast(
        `trigger failed: ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (busy) return;
    if (
      !window.confirm(
        "Clear all loans, transactions, and reset scores? Borrower wallets on Locus are NOT touched.",
      )
    )
      return;
    setBusy(true);
    // Backend wipe
    try {
      const res = await credit.resetDemo();
      const total = Object.values(res.cleared).reduce(
        (sum, v) => sum + (v ?? 0),
        0,
      );
      pushToast(
        total > 0
          ? `Demo reset · ${total} record${total === 1 ? "" : "s"} cleared`
          : "Demo reset",
        "accent",
      );
    } catch (err) {
      console.error("Reset demo failed:", err);
      pushToast(
        `reset failed: ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    }
    // Clear ALL frontend state — CRITICAL: nodeBadges must be reset
    // here, otherwise the previous run's blacklist / holding-escrow
    // overlays bleed into the next run.
    setTriggeredBorrowerId(null);
    setTriggerToken(0);
    setTriggerStartedAt(null);
    setTriggerCustomerSessionId(null);
    setActiveTaskId(null);
    setActiveLoanId(null);
    setNodeBadges({});
    setScoreFlashNode(null);
    setBusy(false);
  }

  // SSE → controlled badges. Only events for the CURRENT activeTaskId
  // (or the loan linked to it) can mutate node badges. Previous runs'
  // events are inert because the activeTaskId / activeLoanId filter
  // rejects them.
  useEffect(() => {
    if (events.length === 0) return;
    for (const e of events) {
      // Skip events from before the current run started — prevents
      // a prior run's loan.defaulted from re-blacklisting borrower-b
      // when the user has just clicked Run A.
      if (triggerStartedAt !== null && e.ts < triggerStartedAt) continue;

      // Capture the loan id once it funds for our active task.
      if (
        e.kind === "loan.funded" &&
        e.linkedTaskId &&
        e.linkedTaskId === activeTaskId
      ) {
        if (activeLoanId !== e.loanId) setActiveLoanId(e.loanId);
      }

      const matchesTask =
        ("taskId" in e && e.taskId === activeTaskId && activeTaskId !== null) ||
        ("linkedTaskId" in e &&
          e.linkedTaskId === activeTaskId &&
          activeTaskId !== null);
      const matchesLoan =
        "loanId" in e && activeLoanId !== null && e.loanId === activeLoanId;

      if (!matchesTask && !matchesLoan) continue;

      if (e.kind === "task.escrow_paid") {
        setNodeBadges((b) => ({
          ...b,
          credit: { type: "holding", amount: 0.008 },
        }));
      } else if (e.kind === "loan.defaulted") {
        const node =
          e.borrowerId === "summarizer" || e.borrowerId === "agent-a"
            ? "borrower-a"
            : e.borrowerId === "code-reviewer" ||
                e.borrowerId === "agent-b"
              ? "borrower-b"
              : null;
        if (node) {
          setNodeBadges((b) => ({ ...b, [node]: { type: "blacklisted" } }));
          setScoreFlashNode(node);
          setTimeout(() => setScoreFlashNode(null), 1200);
        }
      } else if (e.kind === "task.released" || e.kind === "task.refunded") {
        // Escrow no longer held — clear the holding badge.
        setNodeBadges((b) => {
          const next = { ...b };
          delete next.credit;
          return next;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, activeTaskId, activeLoanId]);

  // Lifecycle strip varies by scenario:
  //   Happy path → 3-card escrow flow (no loan involved).
  //   Default path → 5-card credit lifecycle (request → ... → refund).
  const isDefault = triggeredBorrowerId === "agent-b";
  const cardLabels = isDefault
    ? ["REQUEST", "APPROVED", "FUNDED", "COLLECTION FAILED", "REFUNDED"]
    : ["REQUEST", "APPROVED", "FUNDED", "COMMITTED", "REPAID"];

  // Happy-path 5-card escrow strip status. Drive from real task.* events.
  const escrowStripStatus = (() => {
    const matchTask = (e: typeof events[number], kind: string) =>
      e.kind === kind &&
      (e as { taskId?: string }).taskId === activeTaskId;
    const escrowPaid = events.find((e) => matchTask(e, "task.escrow_paid"));
    const dispatched = events.find((e) => matchTask(e, "task.dispatched"));
    const processing = events.find((e) => matchTask(e, "task.processing"));
    const delivered = events.find((e) => matchTask(e, "task.delivered"));
    const released = events.find((e) => matchTask(e, "task.released"));
    return {
      paid: !!escrowPaid || (triggerToken > 0 && !isDefault),
      dispatched: !!dispatched,
      working: !!processing || !!delivered,
      delivered: !!delivered,
      released: !!released,
    };
  })();

  return (
    <main className="min-h-screen relative">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="p-6 max-w-7xl mx-auto">
        <PageHeader
          crumbs={[
            { href: "/", label: "Home" },
            { label: "Live Flow" },
          ]}
        />

        <header className="mb-6 max-w-3xl">
          <div className="text-[11px] uppercase tracking-[0.25em] text-accent font-semibold mb-2">
            Demo · Live money flow
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-accent via-info to-warn bg-clip-text text-transparent">
              Watch USDC move in real time
            </span>
          </h1>
          <p className="text-base text-ink-dim mt-3 leading-relaxed">
            Two scenarios:
            <br />
            <strong className="text-ink">Happy path</strong> — agent has
            funds, does work, escrow released.
            <br />
            <strong className="text-ink">Default path</strong> —
            under-funded agent borrows, can't repay, user is auto-refunded.
          </p>
        </header>

        {/* Symmetric demo buttons */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          <DemoButton
            icon={<Play size={16} />}
            label="Run Loan (Borrower A)"
            tone="accent"
            desc="expected: success · happy path"
            onClick={() => runLoan("agent-a")}
            disabled={busy}
          />
          <DemoButton
            icon={<Play size={16} />}
            label="Run Loan (Borrower B)"
            tone="warnOutline"
            desc="expected: default · auto-refund"
            onClick={() => runLoan("agent-b")}
            disabled={busy}
          />
          <DemoButton
            icon={<RotateCcw size={16} />}
            label="Reset Demo"
            tone="muted"
            desc="wipe state · fresh demo"
            onClick={handleReset}
            disabled={busy}
          />
        </div>

        {/* Two-column 60/40 — graph + checklist */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-8">
          <div className="lg:col-span-3">
            <MoneyFlowGraph
              events={events}
              triggeredBorrowerId={triggeredBorrowerId}
              triggerToken={triggerToken}
              triggerStartedAt={triggerStartedAt}
              nodeBadges={nodeBadges}
              scoreFlashNode={scoreFlashNode as never}
            />
          </div>
          <div className="lg:col-span-2">
            <TransactionChecklist
              mode={checklistMode}
              events={events}
              triggerToken={triggerToken}
              triggerStartedAt={triggerStartedAt}
              activeTaskId={activeTaskId}
            />
          </div>
        </div>

        {/* HAPPY-PATH escrow strip (5 cards) — mirrors checklist. */}
        {triggerToken > 0 && !isDefault && (
          <section className="mb-4">
            <h2 className="text-xs uppercase tracking-widest text-ink-dim font-mono-tight mb-3">
              Escrow flow
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <EscrowCard
                index={1}
                total={5}
                name="ESCROW PAID"
                done={escrowStripStatus.paid}
                icon="🔒"
              >
                User → Credit · $0.0080
              </EscrowCard>
              <EscrowCard
                index={2}
                total={5}
                name="DISPATCHED"
                done={escrowStripStatus.dispatched}
                active={
                  escrowStripStatus.paid && !escrowStripStatus.dispatched
                }
                icon="📨"
              >
                Task handed off to agent
              </EscrowCard>
              <EscrowCard
                index={3}
                total={5}
                name="AGENT WORKING"
                done={escrowStripStatus.working}
                active={
                  escrowStripStatus.dispatched && !escrowStripStatus.working
                }
                icon="⚙️"
              >
                Borrower A using own funds
              </EscrowCard>
              <EscrowCard
                index={4}
                total={5}
                name="DELIVERED"
                done={escrowStripStatus.delivered}
                active={
                  escrowStripStatus.working && !escrowStripStatus.delivered
                }
                icon="📤"
              >
                Output posted back to credit
              </EscrowCard>
              <EscrowCard
                index={5}
                total={5}
                name="ESCROW RELEASED"
                done={escrowStripStatus.released}
                active={
                  escrowStripStatus.delivered && !escrowStripStatus.released
                }
                icon="✓"
              >
                Credit → Borrower A · $0.0080
              </EscrowCard>
            </div>
          </section>
        )}

        {/* 5-card lifecycle strip — only on default scenario (or empty
            state). */}
        {(!triggerToken || isDefault) && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-ink-dim font-mono-tight mb-3">
            {isDefault ? "Default · credit lifecycle" : "Loan lifecycle"}
          </h2>
          <div className={`grid grid-cols-2 ${isDefault ? "md:grid-cols-6" : "md:grid-cols-5"} gap-3`}>
            <FlowCard
              index={1}
              total={isDefault ? 6 : 5}
              name={cardLabels[0]!}
              status={snapshot.cards[0].status}
              icon="⚡"
            >
              <RequestCardContent
                triggeredAt={
                  (snapshot.cards[0].data.triggeredAt as number | undefined) ??
                  triggerStartedAt
                }
              />
            </FlowCard>
            <FlowCard
              index={2}
              total={isDefault ? 6 : 5}
              name={cardLabels[1]!}
              status={snapshot.cards[1].status}
              icon="✓"
            >
              <ApprovedCardContent
                loanId={snapshot.cards[1].data.loanId as string | undefined}
                amount={snapshot.cards[1].data.amount as number | undefined}
                rate={snapshot.cards[1].data.rate as number | undefined}
                repayAmount={
                  snapshot.cards[1].data.repayAmount as number | undefined
                }
              />
            </FlowCard>
            <FlowCard
              index={3}
              total={isDefault ? 6 : 5}
              name={cardLabels[2]!}
              status={snapshot.cards[2].status}
              icon="◆"
            >
              <FundedCardContent
                txHash={
                  snapshot.cards[2].data.txHash as string | null | undefined
                }
                dueAt={snapshot.cards[2].data.dueAt as string | undefined}
              />
            </FlowCard>
            <FlowCard
              index={4}
              total={isDefault ? 6 : 5}
              name={cardLabels[3]!}
              status={
                isDefault && snapshot.cards[4].status === "FAILED"
                  ? "FAILED"
                  : snapshot.cards[3].status
              }
              icon="⏱"
            >
              <CommittedCardContent
                status={snapshot.cards[3].status}
                repaymentSessionId={
                  snapshot.cards[3].data.repaymentSessionId as
                    | string
                    | undefined
                }
                reason={snapshot.cards[3].data.reason as string | undefined}
              />
            </FlowCard>
            <FlowCard
              index={5}
              total={isDefault ? 6 : 5}
              name={cardLabels[4]!}
              status={snapshot.cards[4].status}
              icon="🔒"
            >
              <RepaidCardContent
                status={snapshot.cards[4].status}
                txHash={
                  snapshot.cards[4].data.txHash as string | null | undefined
                }
                reason={snapshot.cards[4].data.reason as string | undefined}
              />
            </FlowCard>
            {isDefault && (
              <FlowCard
                index={6}
                total={6}
                name="BLACKLISTED"
                status={
                  snapshot.cards[4].status === "FAILED" ||
                  snapshot.cards[4].status === "DONE"
                    ? "FAILED"
                    : "WAITING"
                }
                icon="🚫"
              >
                <div className="text-xs text-danger leading-relaxed">
                  Score crashed
                  <br />
                  agent suspended
                </div>
              </FlowCard>
            )}
          </div>
        </section>
        )}

        <Footer />
      </div>
    </main>
  );
}

function EscrowCard({
  index,
  total = 3,
  name,
  done,
  active = false,
  icon,
  children,
}: {
  index: number;
  total?: number;
  name: string;
  done: boolean;
  active?: boolean;
  icon: string;
  children: React.ReactNode;
}) {
  const tone = done
    ? "border-accent bg-accent-soft text-ink"
    : active
      ? "border-accent/60 bg-panel-card text-ink animate-pulse-slow"
      : "border-panel-border bg-panel-card text-ink-dimmer";
  return (
    <div
      className={`rounded-md border transition-all duration-300 p-4 h-32 flex flex-col ${tone}`}
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[10px] font-mono-tight uppercase tracking-widest text-ink-dimmer">
          {index}/{total}
        </span>
        <span className="text-base">{icon}</span>
      </div>
      <div className="font-mono-tight text-[11px] uppercase tracking-wider text-ink-dim mb-2">
        {name}
      </div>
      <div className="text-xs leading-relaxed">{children}</div>
    </div>
  );
}

function DemoButton({
  icon,
  label,
  desc,
  tone,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  desc: string;
  tone: "accent" | "warnOutline" | "muted";
  onClick: () => void;
  disabled?: boolean;
}) {
  const palette: Record<typeof tone, string> = {
    accent:
      "bg-accent text-black hover:bg-accent-dim disabled:bg-accent/40 disabled:text-black/60 border border-accent",
    warnOutline:
      "bg-transparent text-warn border border-warn/60 hover:bg-warn/10 disabled:opacity-50",
    muted:
      "bg-panel-cardHover text-ink border border-panel-borderStrong hover:bg-panel-border",
  };
  return (
    <div className="space-y-1.5">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-md text-sm font-semibold transition-colors disabled:cursor-not-allowed ${palette[tone]}`}
      >
        {icon}
        {label}
      </button>
      <p className="text-[11px] text-ink-dimmer text-center font-mono-tight">
        {desc}
      </p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-16 pt-6 border-t border-panel-border text-center text-xs text-ink-dimmer">
      CREDIT · Agent payment infrastructure · Built for Locus Paygentic
    </footer>
  );
}
