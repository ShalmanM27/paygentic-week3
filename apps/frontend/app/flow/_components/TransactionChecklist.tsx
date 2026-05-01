"use client";

// Beat-driven checklist rendered as a vertical list of rows. Each row
// shows: square status badge → "Step N" eyebrow → title → status pill
// → detail line → optional amount → Locus session + tx hash chips, or
// the "Tx hash: pending…" placeholder while the beat hasn't settled.
// Both happy and default scenarios use the same 5-step layout.

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

  const settled = beatStates.filter(
    (s) => s === "confirmed" || s === "failed",
  ).length;
  const activeIdx = beatStates.findIndex((s) => s === "active");

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
      <div className="px-5 py-4 border-b border-white/10 flex items-baseline justify-between">
        <h3 className="text-xs uppercase tracking-widest text-accent font-mono-tight">
          Transaction checklist
        </h3>
        <span className="text-[11px] text-ink-dimmer font-mono-tight">
          {mode === "happy" ? "Happy path" : "Default path"} · {settled} /{" "}
          {beats.length} settled
        </span>
      </div>
      <ol className="divide-y divide-white/10">
        {beats.map((beat, idx) => {
          const status = beatStates[idx] ?? "pending";
          const ts = beatTimestamps[idx] ?? null;
          const elapsedSec =
            ts && triggerStartedAt
              ? Math.max(0, (ts - triggerStartedAt) / 1000)
              : null;
          const isActive = idx === activeIdx;
          // Stable mock hash + Locus session id so the chips look like
          // real values without needing the backend.
          const hash = mockHashFor(`${runId}-${idx}-${beat.step}`);
          const sessionId = `T_${String(runId).padStart(2, "0")}_${idx + 1}`;
          return (
            <ChecklistRow
              key={`${runId}-${idx}`}
              index={idx + 1}
              beat={beat}
              status={status}
              isActive={isActive}
              elapsedSec={elapsedSec}
              sessionId={sessionId}
              txHash={hash}
            />
          );
        })}
      </ol>
    </div>
  );
}

function ChecklistRow({
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
  const showPending = status === "pending" || status === "active";

  const colorByStatus: Record<BeatStatus, string> = {
    pending: "border-white/15 bg-transparent text-ink-dimmer",
    active: "border-accent bg-transparent text-accent",
    confirmed: "border-accent bg-accent text-black",
    failed: "border-danger bg-danger text-white",
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
            className={`inline-flex items-center justify-center w-6 h-6 rounded-md border-2 transition-colors ${colorByStatus[status]}`}
          >
            {status === "confirmed" && <Check size={14} strokeWidth={3} />}
            {status === "failed" && <X size={14} strokeWidth={3} />}
          </span>
          {isActive && status === "pending" && (
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
                  status === "confirmed"
                    ? "text-ink"
                    : status === "failed"
                      ? "text-danger"
                      : status === "active"
                        ? "text-ink"
                        : "text-ink-dim"
                }`}
              >
                {beat.step}
              </span>
            </div>
            <StatusChip status={status} elapsedSec={elapsedSec} />
          </div>
          <div className="text-xs text-ink-dimmer mt-1">{beat.stepDetail}</div>
          {beat.orb && (
            <div
              className={`text-sm font-mono-tight tabular-nums mt-1 ${
                status === "failed" ? "text-danger" : "text-accent"
              }`}
            >
              ${beat.orb.amount.toFixed(4)} USDC
            </div>
          )}

          {/* Locus + tx-hash chips — visible after the beat settles. */}
          {showRefs && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-mono-tight">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(sessionId);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-white/10 text-ink-dim hover:text-ink hover:bg-white/5 transition-colors"
                title="Click to copy"
              >
                Locus: {sessionId}
                {copied ? (
                  <Check size={10} className="text-accent" />
                ) : (
                  <Copy size={10} />
                )}
              </button>
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-info/30 text-info hover:bg-info/10 transition-colors"
              >
                Tx: {txHash.slice(0, 14)}…
                <ExternalLink size={10} />
              </a>
            </div>
          )}
          {showPending && (
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
  status: BeatStatus;
  elapsedSec: number | null;
}) {
  if (status === "pending") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-ink-dimmer font-mono-tight">
        ⏳ pending
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 border border-accent/40 text-accent font-mono-tight">
        ⟳ in flight
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
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-soft border border-accent/40 text-accent font-mono-tight">
      ✓ confirmed
      {elapsedSec !== null && elapsedSec > 0
        ? ` · ${elapsedSec.toFixed(1)}s`
        : ""}
    </span>
  );
}
