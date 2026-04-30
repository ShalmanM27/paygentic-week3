"use client";

import { useState } from "react";
import type { SseEvent } from "../../../lib/types";

const FILTERS = ["All", "Loans", "Sessions", "Scores", "System"] as const;
type Filter = (typeof FILTERS)[number];

const KIND_ICONS: Record<string, string> = {
  "loan.funded": "▲",
  "loan.repaid": "✓",
  "loan.defaulted": "✕",
  "score.changed": "Δ",
  "score.sold": "$",
  "session.paid": "→",
  "session.expired": "⏱",
  "system.heartbeat": "•",
};

const KIND_COLORS: Record<string, string> = {
  "loan.funded": "text-info",
  "loan.repaid": "text-accent",
  "loan.defaulted": "text-danger",
  "score.changed": "text-warn",
  "score.sold": "text-warn",
  "session.paid": "text-ink-dim",
  "session.expired": "text-ink-dim",
  "system.heartbeat": "text-ink-dimmer",
};

function eventCategory(kind: string): Filter {
  if (kind.startsWith("loan.")) return "Loans";
  if (kind.startsWith("session.")) return "Sessions";
  if (kind.startsWith("score.")) return "Scores";
  return "System";
}

function summarize(e: SseEvent): string {
  switch (e.kind) {
    case "loan.funded":
      return `${e.loanId} funded for ${e.borrowerId} → $${e.amount.toFixed(4)} (repay $${e.repayAmount.toFixed(4)})`;
    case "loan.repaid":
      return `${e.loanId} repaid by ${e.borrowerId}`;
    case "loan.defaulted":
      return `${e.loanId} DEFAULTED (${e.borrowerId}) — ${e.reason}`;
    case "score.changed":
      return `${e.borrowerId} score ${e.from} → ${e.to}`;
    case "score.sold":
      return `score report sold ${e.wallet.slice(0, 10)}… $${e.amount}`;
    case "session.paid":
      return `session paid (${e.purpose}) ${e.sessionId.slice(0, 16)}…`;
    case "session.expired":
      return `session expired (${e.purpose}) ${e.sessionId.slice(0, 16)}…`;
    case "system.heartbeat":
      return `heartbeat uptime=${e.uptimeSec}s`;
    default:
      return JSON.stringify(e);
  }
}

export function RawJsonConsole({ events }: { events: SseEvent[] }) {
  const [active, setActive] = useState<Set<Filter>>(
    new Set(["All", "Loans", "Sessions", "Scores"]),
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (f: Filter): void => {
    setActive((prev) => {
      const next = new Set(prev);
      if (f === "All") {
        return next.has("All")
          ? new Set()
          : new Set(FILTERS);
      }
      if (next.has(f)) next.delete(f);
      else next.add(f);
      // "All" toggles to true if all real categories on
      const allOn = FILTERS.filter((x) => x !== "All").every((x) => next.has(x));
      if (allOn) next.add("All");
      else next.delete("All");
      return next;
    });
  };

  const toggleRow = (i: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const filtered = events.filter((e) => active.has(eventCategory(e.kind)));

  return (
    <div className="space-y-2">
      <div className="flex gap-2 text-xs">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => toggle(f)}
            className={`px-2 py-0.5 rounded font-mono-tight transition-colors ${
              active.has(f)
                ? "bg-accent-soft text-accent border border-accent/40"
                : "bg-panel-cardHover text-ink-dim border border-panel-border hover:text-ink"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-ink-dimmer text-xs ml-auto self-center">
          {filtered.length} event{filtered.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="bg-panel-card border border-panel-border rounded-md max-h-72 overflow-y-auto font-mono-tight text-xs">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-ink-dimmer">
            no events yet — click [▶ Run Loan] to start
          </div>
        ) : (
          filtered.map((e, i) => {
            const cat = eventCategory(e.kind);
            const ts = new Date(e.ts).toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
            const isOpen = expanded.has(i);
            void cat;
            return (
              <div
                key={i}
                className="border-b border-panel-border last:border-b-0"
              >
                <button
                  onClick={() => toggleRow(i)}
                  className="w-full px-3 py-1.5 flex items-baseline gap-3 hover:bg-panel-cardHover text-left"
                >
                  <span className="text-ink-dimmer tabular-nums">{ts}</span>
                  <span
                    className={`${KIND_COLORS[e.kind] ?? "text-ink-dim"} w-3 inline-block`}
                  >
                    {KIND_ICONS[e.kind] ?? "•"}
                  </span>
                  <span className="text-ink-dim flex-shrink-0">{e.kind}</span>
                  <span className="text-ink truncate flex-1">
                    {summarize(e)}
                  </span>
                  <span className="text-ink-dimmer">
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && (
                  <pre className="px-3 pb-2 text-[11px] text-ink-dim overflow-x-auto">
                    {JSON.stringify(e, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
