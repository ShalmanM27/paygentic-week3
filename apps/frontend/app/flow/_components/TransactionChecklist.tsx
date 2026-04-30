"use client";

// V3 — persistent step-by-step checklist that fills in as SSE events
// arrive. Steps are pre-rendered as PENDING; checkboxes flip to
// CONFIRMED with a tx hash + Locus session id when their corresponding
// event lands. This is the third pillar of the /flow narrative
// (alongside the animated graph and the 5-card lifecycle strip).

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import type { SseEvent } from "../../../lib/types";

export type ChecklistMode = "happy" | "default" | "idle";

interface MatchCtx {
  activeTaskId: string | null;
}
interface StepDef {
  id: string;
  title: string;
  detail: string;
  amount: number | null;
  /** Predicate against an SSE event to mark this step CONFIRMED. */
  match: (e: SseEvent, ctx: MatchCtx) => boolean;
  /** Predicate against an SSE event that, if it fires, marks this step
   *  FAILED instead of CONFIRMED. */
  matchFailed?: (e: SseEvent, ctx: MatchCtx) => boolean;
  /** When true, the step is purely synthetic (e.g. trigger click) and
   *  marked CONFIRMED immediately. */
  synthetic?: boolean;
  /** When true, this step is OPTIONAL — if a "sweep" terminal event
   *  fires (task.released / task.refunded) and the step is still
   *  pending, mark it SKIPPED instead of leaving it stuck. Used for
   *  borrow-related steps that don't fire when the agent has enough
   *  balance to fulfill from its own wallet. */
  optional?: boolean;
  /** When set, this step auto-completes N ms after a parent step's
   *  match event fires. Used for narrative beats that don't have a
   *  dedicated SSE event. */
  cosmeticAfterMs?: number;
  cosmeticAfterStepId?: string;
}

// Helpers — extract and compare task identity on different event kinds.
function eventTaskId(e: SseEvent): string | null {
  if ("taskId" in e && typeof e.taskId === "string") return e.taskId;
  if ("linkedTaskId" in e && typeof e.linkedTaskId === "string") {
    return e.linkedTaskId;
  }
  return null;
}
function matchesActiveTask(e: SseEvent, ctx: MatchCtx): boolean {
  if (!ctx.activeTaskId) return false;
  return eventTaskId(e) === ctx.activeTaskId;
}

// /flow page now drives the FULL escrow + loan + release path via
// credit.createTask + credit.simulatePay. SSE events flow:
//   task.escrow_paid → (loan.funded if borrow needed) → task.processing
//   → (loan.repaid if borrowed) → task.released
// or for the default path:
//   task.escrow_paid → loan.funded → task.processing → loan.defaulted
//   → task.refunded
// HAPPY PATH — agent has sufficient balance, no loan needed. Five
// steps mirror the full task lifecycle so the demo narrates each
// real backend transition (paid → dispatched → processing →
// delivered → released).
const HAPPY_STEPS: StepDef[] = [
  {
    id: "h1",
    title: "User pays escrow",
    detail: "USER → CREDIT PLATFORM",
    amount: 0.008,
    match: (e, ctx) =>
      e.kind === "task.escrow_paid" && matchesActiveTask(e, ctx),
  },
  {
    id: "h2",
    title: "Credit dispatches to agent",
    detail: "Task handed off · agent acknowledged",
    amount: null,
    match: (e, ctx) =>
      e.kind === "task.dispatched" && matchesActiveTask(e, ctx),
  },
  {
    id: "h3",
    title: "Borrower does the work",
    detail: "Agent uses own funds — no loan needed",
    amount: null,
    match: (e, ctx) =>
      e.kind === "task.processing" && matchesActiveTask(e, ctx),
  },
  {
    id: "h4",
    title: "Output delivered",
    detail: "Agent posted result back to credit platform",
    amount: null,
    match: (e, ctx) =>
      e.kind === "task.delivered" && matchesActiveTask(e, ctx),
  },
  {
    id: "h5",
    title: "Credit releases escrow",
    detail: "CREDIT → BORROWER (paid for verified delivery)",
    amount: 0.008,
    match: (e, ctx) =>
      e.kind === "task.released" && matchesActiveTask(e, ctx),
  },
];

const DEFAULT_STEPS: StepDef[] = [
  {
    id: "d1",
    title: "User pays escrow",
    detail: "USER → CREDIT PLATFORM",
    amount: 0.008,
    match: (e, ctx) =>
      e.kind === "task.escrow_paid" && matchesActiveTask(e, ctx),
  },
  {
    id: "d2",
    title: "Credit extends loan",
    detail: "CREDIT → BORROWER B",
    amount: 0.003,
    match: (e, ctx) =>
      e.kind === "loan.funded" && matchesActiveTask(e, ctx),
    optional: true,
  },
  {
    id: "d3",
    title: "Borrower attempts work",
    detail: "Agent processing the task",
    amount: null,
    match: (e, ctx) =>
      (e.kind === "task.processing" || e.kind === "task.delivered") &&
      matchesActiveTask(e, ctx),
  },
  {
    id: "d4",
    title: "Borrower fails to repay",
    detail: "Insufficient funds · max attempts reached",
    amount: null,
    match: () => false,
    matchFailed: (e, ctx) =>
      (e.kind === "loan.defaulted" || e.kind === "task.failed") &&
      matchesActiveTask(e, ctx),
  },
  {
    id: "d5",
    title: "Credit refunds escrow",
    detail: "CREDIT → USER (auto-refund)",
    amount: 0.008,
    match: (e, ctx) =>
      e.kind === "task.refunded" && matchesActiveTask(e, ctx),
    cosmeticAfterStepId: "d4",
    cosmeticAfterMs: 800,
  },
  {
    id: "d6",
    title: "Borrower B blacklisted",
    detail: "Score crashes · agent suspended",
    amount: null,
    // Strictly cosmetic — fires from the timer only. Previously this
    // also matched score.changed, which fires on the score-recompute
    // loop (every 5s) and could land BEFORE d5's 800ms cosmetic timer,
    // visually checking off d6 ahead of d5. Removed so the sequence
    // is: d4 fails → 800ms → d5 → 1500ms total → d6.
    match: () => false,
    cosmeticAfterStepId: "d4",
    cosmeticAfterMs: 1500,
  },
];

type StepStatus = "pending" | "confirmed" | "failed" | "skipped";

interface StepState {
  status: StepStatus;
  txHash: string | null;
  sessionId: string | null;
  ts: number | null;
}

function mockHashFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return "0x" + h.toString(16).padStart(8, "0") + "mock1234";
}

function eventMeta(e: SseEvent): {
  txHash: string | null;
  sessionId: string | null;
} {
  return {
    txHash:
      "txHash" in e && e.txHash
        ? (e.txHash as string)
        : "releaseTxHash" in e && e.releaseTxHash
          ? (e.releaseTxHash as string)
          : null,
    sessionId:
      "sessionId" in e
        ? (e.sessionId as string)
        : "loanId" in e
          ? (e.loanId as string)
          : "taskId" in e
            ? (e.taskId as string)
            : null,
  };
}

export function TransactionChecklist({
  mode,
  events,
  triggerToken,
  triggerStartedAt,
  activeTaskId,
}: {
  mode: ChecklistMode;
  events: SseEvent[];
  triggerToken: number;
  triggerStartedAt: number | null;
  activeTaskId: string | null;
}) {
  const steps = useMemo<StepDef[]>(() => {
    if (mode === "happy") return HAPPY_STEPS;
    if (mode === "default") return DEFAULT_STEPS;
    return [];
  }, [mode]);

  const [stepStates, setStepStates] = useState<Record<string, StepState>>({});

  // Reset on triggerToken change.
  useEffect(() => {
    if (triggerToken === 0 || mode === "idle") {
      setStepStates({});
      return;
    }
    const initial: Record<string, StepState> = {};
    steps.forEach((s) => {
      initial[s.id] = {
        status: s.synthetic ? "confirmed" : "pending",
        txHash: s.synthetic
          ? mockHashFor(`trigger-${triggerToken}-${s.id}`)
          : null,
        sessionId: s.synthetic ? `escrow-${triggerToken}` : null,
        ts: s.synthetic ? triggerStartedAt : null,
      };
    });
    setStepStates(initial);
  }, [triggerToken, mode, steps, triggerStartedAt]);

  // Cosmetic-after timer: fire dependent steps after their parent lands.
  useEffect(() => {
    if (mode === "idle") return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const step of steps) {
      if (!step.cosmeticAfterStepId || step.cosmeticAfterMs === undefined) {
        continue;
      }
      const me = stepStates[step.id];
      if (!me || me.status !== "pending") continue;
      const parent = stepStates[step.cosmeticAfterStepId];
      if (!parent || parent.status === "pending") continue;
      const fireAt = (parent.ts ?? Date.now()) + (step.cosmeticAfterMs ?? 0);
      const delay = Math.max(0, fireAt - Date.now());
      const stepId = step.id;
      timers.push(
        setTimeout(() => {
          setStepStates((prev) => {
            const cur = prev[stepId];
            if (!cur || cur.status !== "pending") return prev;
            return {
              ...prev,
              [stepId]: {
                status: "confirmed",
                txHash: mockHashFor(`${stepId}-cosmetic`),
                sessionId: cur.sessionId,
                ts: Date.now(),
              },
            };
          });
        }, delay),
      );
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [stepStates, steps, mode]);

  // Sweep-pending-on-terminal: ONLY when a terminal event for the
  // ACTIVE task lands (task.released / task.refunded). This is how
  // h2/h4 (or d2) clear when the agent had enough balance to fulfill
  // without borrowing.
  //
  // Critical: we must check that no loan.funded for activeTaskId is
  // present in events before marking borrow steps skipped. Positive
  // evidence required.
  useEffect(() => {
    if (mode === "idle" || events.length === 0) return;
    if (!activeTaskId) return;
    const terminal = events.find(
      (e) =>
        (e.kind === "task.released" || e.kind === "task.refunded") &&
        eventTaskId(e) === activeTaskId,
    );
    if (!terminal) return;
    // Did a loan ever get funded for this task? If yes, optional
    // borrow steps should NOT be skipped — they should be confirmed
    // (h2) or eventually confirmed/failed (h4) by their own match.
    const loanFundedForTask = events.some(
      (e) => e.kind === "loan.funded" && eventTaskId(e) === activeTaskId,
    );
    setStepStates((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const step of steps) {
        if (!step.optional) continue;
        const cur = next[step.id];
        if (!cur || cur.status !== "pending") continue;
        // Don't skip borrow steps if a loan actually funded for this
        // task — wait for their own match predicate instead.
        if (loanFundedForTask) continue;
        next[step.id] = {
          status: "skipped",
          txHash: null,
          sessionId: null,
          ts: terminal.ts,
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [events, steps, mode, activeTaskId]);

  // Match SSE events to steps. Each step's match predicate now also
  // takes a context with activeTaskId so we can filter by linkedTaskId.
  useEffect(() => {
    if (mode === "idle" || events.length === 0) return;
    const ctx: MatchCtx = { activeTaskId };
    setStepStates((prev) => {
      const next = { ...prev };
      let changed = false;
      // Skip events from prior runs.
      const ordered = [...events]
        .filter((ev) =>
          triggerStartedAt !== null ? ev.ts >= triggerStartedAt : true,
        )
        .sort((a, b) => a.ts - b.ts);
      for (const e of ordered) {
        for (const step of steps) {
          const st = next[step.id];
          if (!st || st.status !== "pending") continue;
          if (step.matchFailed && step.matchFailed(e, ctx)) {
            const meta = eventMeta(e);
            next[step.id] = {
              status: "failed",
              txHash: meta.txHash,
              sessionId: meta.sessionId,
              ts: e.ts,
            };
            changed = true;
            continue;
          }
          if (step.match(e, ctx)) {
            const meta = eventMeta(e);
            next[step.id] = {
              status: "confirmed",
              txHash: meta.txHash ?? mockHashFor(meta.sessionId ?? step.id),
              sessionId: meta.sessionId,
              ts: e.ts,
            };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [events, mode, steps, activeTaskId]);

  if (mode === "idle") {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur p-8 text-center">
        <div className="text-4xl mb-3" aria-hidden>
          📋
        </div>
        <p className="text-sm text-ink-dim">
          Click <strong>Run Loan</strong> to start a transaction. Each step
          will check off with its real Locus session and BaseScan tx hash.
        </p>
      </div>
    );
  }

  // Find the first pending step → that's the active one.
  const activeIdx = steps.findIndex(
    (s) => stepStates[s.id]?.status === "pending",
  );

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10 flex items-baseline justify-between">
        <h3 className="text-xs uppercase tracking-widest text-accent font-mono-tight">
          Transaction checklist
        </h3>
        <span className="text-[11px] text-ink-dimmer font-mono-tight">
          {mode === "happy" ? "Happy path" : "Default path"} ·{" "}
          {
            Object.values(stepStates).filter(
              (s) =>
                s.status === "confirmed" ||
                s.status === "skipped" ||
                s.status === "failed",
            ).length
          }{" "}
          / {steps.length} settled
        </span>
      </div>
      <ol className="divide-y divide-white/10">
        {steps.map((step, idx) => {
          const state = stepStates[step.id] ?? {
            status: "pending" as const,
            txHash: null,
            sessionId: null,
            ts: null,
          };
          const isActive = idx === activeIdx;
          const elapsedSec =
            state.ts && triggerStartedAt
              ? Math.max(0, (state.ts - triggerStartedAt) / 1000)
              : null;
          return (
            <ChecklistRow
              key={step.id}
              index={idx + 1}
              step={step}
              state={state}
              isActive={isActive}
              elapsedSec={elapsedSec}
            />
          );
        })}
      </ol>
    </div>
  );
}

function ChecklistRow({
  index,
  step,
  state,
  isActive,
  elapsedSec,
}: {
  index: number;
  step: StepDef;
  state: StepState;
  isActive: boolean;
  elapsedSec: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const colorByStatus: Record<StepStatus, string> = {
    pending: "border-white/15 bg-transparent text-ink-dimmer",
    confirmed: "border-accent bg-accent text-black",
    failed: "border-danger bg-danger text-white",
    skipped: "border-white/10 bg-white/[0.02] text-ink-dimmer",
  };
  return (
    <motion.li
      layout
      className={`px-5 py-4 ${
        isActive ? "bg-white/[0.03]" : ""
      } transition-colors`}
    >
      <div className="flex items-start gap-3">
        <div className="relative flex-shrink-0">
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-md border-2 transition-colors ${
              colorByStatus[state.status]
            }`}
          >
            {state.status === "confirmed" && <Check size={14} strokeWidth={3} />}
            {state.status === "failed" && <X size={14} strokeWidth={3} />}
            {state.status === "skipped" && (
              <span className="text-base leading-none">⊘</span>
            )}
          </span>
          {isActive && state.status === "pending" && (
            <span className="absolute inset-0 rounded-md border-2 border-accent animate-ping" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-widest text-ink-dimmer font-mono-tight">
                Step {index}
              </span>
              <span
                className={`text-sm font-medium ${
                  state.status === "confirmed"
                    ? "text-ink"
                    : state.status === "failed"
                      ? "text-danger"
                      : state.status === "skipped"
                        ? "text-ink-dimmer line-through"
                        : "text-ink-dim"
                }`}
              >
                {step.title}
              </span>
            </div>
            <StatusChip status={state.status} elapsedSec={elapsedSec} />
          </div>
          <div className="text-xs text-ink-dimmer mt-1">{step.detail}</div>
          {step.amount !== null && (
            <div className="text-sm text-accent font-mono-tight tabular-nums mt-1">
              ${step.amount.toFixed(4)} USDC
            </div>
          )}

          {/* Locus + tx-hash chips */}
          {(state.sessionId || state.txHash) && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-mono-tight">
              {state.sessionId && (
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(state.sessionId!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-white/10 text-ink-dim hover:text-ink hover:bg-white/5 transition-colors"
                  title="Click to copy"
                >
                  Locus: {state.sessionId.slice(0, 18)}
                  {state.sessionId.length > 18 ? "…" : ""}
                  {copied ? (
                    <Check size={10} className="text-accent" />
                  ) : (
                    <Copy size={10} />
                  )}
                </button>
              )}
              {state.txHash && (
                <a
                  href={`https://basescan.org/tx/${state.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-info/30 text-info hover:bg-info/10 transition-colors"
                >
                  Tx: {state.txHash.slice(0, 14)}…
                  <ExternalLink size={10} />
                </a>
              )}
            </div>
          )}
          {state.status === "pending" && (
            <div className="mt-2 text-[11px] text-ink-dimmer">
              Tx hash: pending…
            </div>
          )}
        </div>
      </div>
    </motion.li>
  );
}

function StatusChip({
  status,
  elapsedSec,
}: {
  status: StepStatus;
  elapsedSec: number | null;
}) {
  if (status === "pending") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-ink-dimmer font-mono-tight">
        ⏳ pending
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger-soft border border-danger/40 text-danger font-mono-tight">
        ✗ failed
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span
        className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.02] border border-white/10 text-ink-dimmer font-mono-tight"
        title="Agent had sufficient balance — borrow not needed"
      >
        ⊘ skipped
      </span>
    );
  }
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-soft border border-accent/40 text-accent font-mono-tight">
      ✓ confirmed
      {elapsedSec !== null && elapsedSec > 0 ? ` · ${elapsedSec.toFixed(1)}s` : ""}
    </span>
  );
}
