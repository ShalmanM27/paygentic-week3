"use client";

// /flow page — beat-driven demo. The parent owns ONE timeline and
// drives both the graph and the checklist from it, so they progress in
// perfect sync. SSE / backend calls still happen for backend
// correctness (a real Locus session is created on each Run Loan), but
// the visible narrative pacing is dictated by the local timeline.

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Play, RotateCcw } from "lucide-react";
import { credit } from "../../lib/credit-client";
import { MoneyFlowGraph } from "./_components/MoneyFlowGraph";
import { TransactionChecklist } from "./_components/TransactionChecklist";
import { ToastStack, type ToastMessage } from "./_components/Toast";
import { PageHeader } from "../../components/PageHeader";
import {
  type BeatStatus,
  type ScenarioKind,
  getBeats,
} from "./_components/flow-beats";

export default function FlowPage() {
  const [scenario, setScenario] = useState<ScenarioKind | null>(null);
  const [runId, setRunId] = useState(0);
  const [triggerStartedAt, setTriggerStartedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [beatStates, setBeatStates] = useState<BeatStatus[]>([]);
  const [beatTimestamps, setBeatTimestamps] = useState<Array<number | null>>(
    [],
  );
  const [activeBeatIdx, setActiveBeatIdx] = useState<number | null>(null);
  const toastIdRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const beats = useMemo(() => getBeats(scenario), [scenario]);
  const checklistMode = scenario ?? "idle";

  function pushToast(text: string, variant: ToastMessage["variant"] = "info") {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text, variant }]);
  }
  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function clearTimers() {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }

  // Scheduled beat advancement — runs the timeline for the current
  // scenario. Each beat has two transitions: pending→active at startMs,
  // active→confirmed (or failed) at confirmMs.
  function startBeatTimeline(kind: ScenarioKind) {
    const list = getBeats(kind);
    setBeatStates(list.map(() => "pending"));
    setBeatTimestamps(list.map(() => null));
    setActiveBeatIdx(null);
    list.forEach((beat, idx) => {
      timersRef.current.push(
        setTimeout(() => {
          setBeatStates((prev) => {
            const next = [...prev];
            next[idx] = "active";
            return next;
          });
          setActiveBeatIdx(idx);
        }, beat.startMs),
      );
      timersRef.current.push(
        setTimeout(() => {
          const settledStatus: BeatStatus = beat.confirmAs ?? "confirmed";
          setBeatStates((prev) => {
            const next = [...prev];
            next[idx] = settledStatus;
            return next;
          });
          setBeatTimestamps((prev) => {
            const next = [...prev];
            next[idx] = Date.now();
            return next;
          });
        }, beat.confirmMs),
      );
    });
    // Clear active-beat banner shortly after the last confirm.
    const finalConfirm = list[list.length - 1]?.confirmMs ?? 0;
    timersRef.current.push(
      setTimeout(() => {
        setActiveBeatIdx(null);
      }, finalConfirm + 1500),
    );
  }

  async function runLoan(borrowerId: "agent-a" | "agent-b") {
    if (busy) return;
    setBusy(true);
    clearTimers();
    const kind: ScenarioKind = borrowerId === "agent-a" ? "happy" : "default";
    setScenario(kind);
    setTriggerStartedAt(Date.now());
    setRunId((n) => n + 1);
    pushToast(
      kind === "happy"
        ? "▶ Happy path — watch the orbs settle"
        : "▶ Default path — repayment will fail",
      kind === "happy" ? "accent" : "warn",
    );
    // Scroll the stage into view so the demo is the focus.
    requestAnimationFrame(() => {
      stageRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    startBeatTimeline(kind);
    // Fire the real backend call in the background so we stay honest
    // about what the demo represents — but it's not on the visual
    // critical path any more.
    try {
      const agentId =
        borrowerId === "agent-a" ? "summarizer" : "code-reviewer";
      const input =
        borrowerId === "agent-a"
          ? "Demo: explain how agent escrow works in 2 sentences"
          : "Demo: explain why this borrower will default in 2 sentences";
      const created = await credit.createTask({
        agentId,
        input,
        userIdentifier: "demo-flow-page",
      });
      void credit.simulatePay(created.sessionId).catch(() => {});
    } catch (err) {
      // Backend not running? Demo still tells the story locally.
      console.warn("[/flow] backend createTask failed (offline?)", err);
    } finally {
      // Re-enable buttons after the timeline ends.
      const list = getBeats(kind);
      const finalAt = list[list.length - 1]?.confirmMs ?? 0;
      timersRef.current.push(
        setTimeout(() => setBusy(false), finalAt + 800),
      );
    }
  }

  async function handleReset() {
    if (busy) return;
    if (
      !window.confirm(
        "Clear all loans, transactions, and reset scores? Borrower wallets on Locus are NOT touched.",
      )
    ) {
      return;
    }
    clearTimers();
    setBusy(true);
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
    setScenario(null);
    setBeatStates([]);
    setBeatTimestamps([]);
    setActiveBeatIdx(null);
    setTriggerStartedAt(null);
    setRunId((n) => n + 1);
    setBusy(false);
  }

  useEffect(() => () => clearTimers(), []);

  const activeBeat =
    activeBeatIdx !== null && beats[activeBeatIdx] ? beats[activeBeatIdx] : null;

  return (
    <>
      <PageHeader />
      <motion.main
        className="min-h-screen relative"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <ToastStack toasts={toasts} onDismiss={dismissToast} />

        <div className="max-w-7xl mx-auto px-6 py-16">
        <header className="mb-12 max-w-3xl">
          <div className="text-eyebrow mb-3">Demo · Live money flow</div>
          <h1 className="text-display text-white mb-5">
            Watch USDC <em>move.</em>
          </h1>
          <p className="text-body leading-relaxed">
            Every orb is a real Locus session. Every hash settles on Base.
            <br />
            <strong className="text-ink">Happy path</strong> — User pays
            escrow, Credit lends working capital, Borrower works, repays,
            and earns the escrow.
            <br />
            <strong className="text-ink">Default path</strong> — Borrower
            can't repay, escrow auto-refunds to User, agent is blacklisted.
          </p>
        </header>

        {/* Scenario controls */}
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

        {/* Stage — scroll target on Run Loan click. Banner, graph,
            and stepper all live inside this anchor so the focus snaps
            to the demo when a run starts. */}
        <div ref={stageRef} className="scroll-mt-4">
          <BeatBanner beat={activeBeat} />
          <div className="mb-6">
            <MoneyFlowGraph
              scenario={scenario}
              beats={beats}
              beatStates={beatStates}
              runId={runId}
            />
          </div>
          <div className="mb-8">
            <TransactionChecklist
              mode={checklistMode}
              beats={beats}
              beatStates={beatStates}
              beatTimestamps={beatTimestamps}
              triggerStartedAt={triggerStartedAt}
              runId={runId}
            />
          </div>
        </div>

        <Footer />
        </div>
      </motion.main>
    </>
  );
}

function BeatBanner({
  beat,
}: {
  beat: { title: string; desc: string } | null;
}) {
  return (
    <div className="mb-6 min-h-[88px]">
      <AnimatePresence mode="wait">
        {beat ? (
          <motion.div
            key={beat.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="rounded-xl border border-accent/40 bg-gradient-to-r from-accent/15 via-accent/5 to-transparent backdrop-blur px-6 py-4 shadow-lg shadow-accent/10"
          >
            <div className="text-[10px] uppercase tracking-[0.3em] text-accent font-semibold mb-1">
              ▌ Live narrative
            </div>
            <div className="text-lg md:text-xl font-bold text-ink leading-snug">
              {beat.title}
            </div>
            <div className="text-sm text-ink-dim mt-1 leading-relaxed">
              {beat.desc}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-4"
          >
            <div className="text-[10px] uppercase tracking-[0.3em] text-ink-dimmer font-semibold mb-1">
              ▌ Demo idle
            </div>
            <div className="text-base text-ink-dim">
              Click a Run Loan button to start. Each step will narrate live
              and the graph below will animate in lock-step.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
