"use client";

// Beat-driven checklist rendered as a horizontal stepper. Each beat is
// a column showing: index → title → status icon → amount → tx chip.
// The active step expands and lifts; settled steps collapse to a
// compact card; pending steps stay muted.

import { motion } from "framer-motion";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import {
  type Beat,
  type BeatStatus,
  type ScenarioKind,
  mockHashFor,
} from "./flow-beats";

export type ChecklistMode = ScenarioKind | "idle";

interface TransactionChecklistProps {
  mode: ChecklistMode;
  beats: Beat[];
  beatStates: BeatStatus[];
  beatTimestamps: Array<number | null>;
  triggerStartedAt: number | null;
  runId: number;
}

export function TransactionChecklist({
  mode,
  beats,
  beatStates,
  beatTimestamps,
  triggerStartedAt,
  runId,
}: TransactionChecklistProps) {
  if (mode === "idle") {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur p-6 text-center">
        <p className="text-sm text-ink-dim">
          📋 Click <strong>Run Loan</strong> to start a transaction. The
          stepper below fills in left → right in lock-step with the graph
          orbs.
        </p>
      </div>
    );
  }

  const settled = beatStates.filter(
    (s) => s === "confirmed" || s === "failed",
  ).length;
  const activeIdx = beatStates.findIndex((s) => s === "active");

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
      <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-widest text-accent font-mono-tight">
          Transaction stepper
        </h3>
        <span className="text-[11px] text-ink-dimmer font-mono-tight">
          {mode === "happy" ? "Happy path" : "Default path"} · {settled} /{" "}
          {beats.length} settled
        </span>
      </div>
      <div className="relative px-5 py-5">
        {/* Connector line under the icons */}
        <div
          className="absolute left-8 right-8 top-[58px] h-[2px] bg-white/10"
          aria-hidden
        />
        <div
          className="absolute left-8 top-[58px] h-[2px] bg-accent transition-[width] duration-700"
          style={{
            width: `calc((100% - 64px) * ${
              beats.length > 1
                ? settled / (beats.length - 1)
                : 0
            })`,
          }}
          aria-hidden
        />
        <ol
          className="relative grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${beats.length}, minmax(0, 1fr))`,
          }}
        >
          {beats.map((beat, idx) => {
            const status = beatStates[idx] ?? "pending";
            const ts = beatTimestamps[idx] ?? null;
            const elapsedSec =
              ts && triggerStartedAt
                ? Math.max(0, (ts - triggerStartedAt) / 1000)
                : null;
            const hash = mockHashFor(`${runId}-${idx}-${beat.step}`);
            const sessionId = `T_${String(runId).padStart(2, "0")}_${idx + 1}`;
            return (
              <ChecklistColumn
                key={`${runId}-${idx}`}
                index={idx + 1}
                beat={beat}
                status={status}
                isActive={idx === activeIdx}
                elapsedSec={elapsedSec}
                sessionId={sessionId}
                txHash={hash}
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function ChecklistColumn({
  index,
  beat,
  status,
  isActive,
  elapsedSec,
  sessionId,
  txHash,
}: {
  index: number;
  beat: Beat;
  status: BeatStatus;
  isActive: boolean;
  elapsedSec: number | null;
  sessionId: string;
  txHash: string;
}) {
  const [copied, setCopied] = useState(false);
  const showRefs = status === "confirmed" || status === "failed";
  const settled = status === "confirmed" || status === "failed";

  const iconCls =
    status === "confirmed"
      ? "border-accent bg-accent text-black"
      : status === "failed"
        ? "border-danger bg-danger text-white"
        : status === "active"
          ? "border-accent bg-transparent text-accent"
          : "border-white/15 bg-transparent text-ink-dimmer";

  return (
    <motion.li
      layout
      initial={false}
      animate={{
        scale: isActive ? 1.04 : 1,
      }}
      className={`flex flex-col items-center text-center px-2 ${
        isActive ? "" : "opacity-95"
      }`}
    >
      <div className="text-[9px] uppercase tracking-widest text-ink-dimmer font-mono-tight mb-2">
        Step {index}
      </div>
      <div className="relative">
        <span
          className={`relative z-10 inline-flex items-center justify-center w-9 h-9 rounded-full border-2 transition-colors ${iconCls} ${
            isActive ? "shadow-[0_0_0_6px_rgba(34,197,94,0.18)]" : ""
          }`}
        >
          {status === "confirmed" ? (
            <Check size={16} strokeWidth={3} />
          ) : status === "failed" ? (
            <X size={16} strokeWidth={3} />
          ) : (
            <span className="text-[12px] font-bold">{index}</span>
          )}
        </span>
        {isActive && (
          <span
            className="absolute inset-0 rounded-full border-2 border-accent animate-ping"
            aria-hidden
          />
        )}
      </div>
      <div
        className={`mt-3 text-[12px] font-semibold leading-tight ${
          status === "failed"
            ? "text-danger"
            : status === "confirmed" || status === "active"
              ? "text-ink"
              : "text-ink-dim"
        }`}
      >
        {beat.step}
      </div>
      <div className="mt-1 text-[10px] text-ink-dimmer leading-snug min-h-[28px]">
        {beat.stepDetail}
      </div>
      {beat.orb && (
        <div
          className={`mt-1 text-[12px] font-mono-tight tabular-nums ${
            status === "failed"
              ? "text-danger"
              : settled
                ? "text-accent"
                : "text-ink-dim"
          }`}
        >
          ${beat.orb.amount.toFixed(4)}
        </div>
      )}
      <StatusChip status={status} elapsedSec={elapsedSec} />
      {showRefs && (
        <div className="mt-2 flex flex-col gap-1 text-[10px] font-mono-tight w-full">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(sessionId);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-white/10 text-ink-dim hover:text-ink hover:bg-white/5 transition-colors"
            title="Click to copy"
          >
            {sessionId}
            {copied ? (
              <Check size={9} className="text-accent" />
            ) : (
              <Copy size={9} />
            )}
          </button>
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded border border-info/30 text-info hover:bg-info/10 transition-colors truncate"
          >
            {txHash.slice(0, 8)}…
            <ExternalLink size={9} />
          </a>
        </div>
      )}
    </motion.li>
  );
}

function StatusChip({
  status,
  elapsedSec,
}: {
  status: BeatStatus;
  elapsedSec: number | null;
}) {
  if (status === "pending") {
    return (
      <span className="mt-2 text-[9px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-ink-dimmer font-mono-tight">
        pending
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="mt-2 text-[9px] px-2 py-0.5 rounded-full bg-accent/10 border border-accent/40 text-accent font-mono-tight">
        ⟳ in flight
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="mt-2 text-[9px] px-2 py-0.5 rounded-full bg-danger-soft border border-danger/40 text-danger font-mono-tight">
        ✗ failed
      </span>
    );
  }
  return (
    <span className="mt-2 text-[9px] px-2 py-0.5 rounded-full bg-accent-soft border border-accent/40 text-accent font-mono-tight">
      ✓ confirmed
      {elapsedSec !== null && elapsedSec > 0
        ? ` · ${elapsedSec.toFixed(1)}s`
        : ""}
    </span>
  );
}
