"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { credit } from "../lib/credit-client";
import { fmtPct, fmtTime } from "../lib/format";
import { tierFor } from "../lib/policy";
import { useCreditEvents } from "../lib/sse";
import {
  Card,
  Section,
  StatusPill,
  Tag,
  TxHash,
  USDC,
} from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import type { SseEvent } from "../lib/types";

type Stats = Awaited<ReturnType<typeof credit.getStats>>;
type AgentResponse = Awaited<ReturnType<typeof credit.getAgent>>;

const KNOWN_BORROWERS = ["agent-a", "agent-b"] as const;

const FILTERS = ["Loans", "Sessions", "Scores", "System"] as const;
type Filter = (typeof FILTERS)[number];

function eventCategory(kind: string): Filter {
  if (kind.startsWith("loan.")) return "Loans";
  if (kind.startsWith("session.")) return "Sessions";
  if (kind.startsWith("score.")) return "Scores";
  return "System";
}

const KIND_ICON: Record<string, string> = {
  "loan.funded": "▲",
  "loan.repaid": "✓",
  "loan.defaulted": "✕",
  "score.changed": "Δ",
  "score.sold": "$",
  "session.paid": "→",
  "session.expired": "⏱",
  "system.heartbeat": "•",
};
const KIND_COLOR: Record<string, string> = {
  "loan.funded": "text-info",
  "loan.repaid": "text-accent",
  "loan.defaulted": "text-danger",
  "score.changed": "text-warn",
  "score.sold": "text-warn",
};

function summarize(e: SseEvent): string {
  switch (e.kind) {
    case "loan.funded":
      return `${e.loanId} funded — ${e.borrowerId} $${e.amount.toFixed(4)} repay $${e.repayAmount.toFixed(4)}`;
    case "loan.repaid":
      return `${e.loanId} repaid by ${e.borrowerId}`;
    case "loan.defaulted":
      return `${e.loanId} DEFAULTED — ${e.borrowerId} (${e.reason})`;
    case "score.changed":
      return `${e.borrowerId} score ${e.from} → ${e.to}`;
    case "score.sold":
      return `score report sold ${e.wallet.slice(0, 10)}…`;
    case "session.paid":
      return `session paid (${e.purpose}) ${e.sessionId.slice(0, 16)}…`;
    case "session.expired":
      return `session expired (${e.purpose})`;
    case "system.heartbeat":
      return `heartbeat ${e.uptimeSec}s`;
    default:
      return JSON.stringify(e);
  }
}

export default function Dashboard() {
  const { events } = useCreditEvents();
  const [stats, setStats] = useState<Stats | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentResponse>>({});
  const [filters, setFilters] = useState<Set<Filter>>(
    new Set(["Loans", "Sessions", "Scores"]),
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const lastTriggerRef = useRef(0);

  async function refreshStats() {
    try {
      setStats(await credit.getStats());
    } catch {
      /* silent */
    }
  }
  async function refreshAgents() {
    const updates = await Promise.allSettled(
      KNOWN_BORROWERS.map((b) => credit.getAgent(b)),
    );
    setAgents((prev) => {
      const next = { ...prev };
      updates.forEach((r, i) => {
        const id = KNOWN_BORROWERS[i]!;
        if (r.status === "fulfilled") next[id] = r.value;
        else delete next[id];
      });
      return next;
    });
  }

  useEffect(() => {
    refreshStats();
    refreshAgents();
    const s = setInterval(refreshStats, 5000);
    const a = setInterval(refreshAgents, 10000);
    return () => {
      clearInterval(s);
      clearInterval(a);
    };
  }, []);

  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    if (last.kind === "system.heartbeat") return;
    const now = Date.now();
    if (now - lastTriggerRef.current < 800) return;
    lastTriggerRef.current = now;
    refreshStats();
    if (last.kind === "score.changed" && "borrowerId" in last) {
      const id = last.borrowerId;
      credit.getAgent(id).then(
        (a) => setAgents((prev) => ({ ...prev, [id]: a })),
        () => {},
      );
    } else if (last.kind.startsWith("loan.")) {
      refreshAgents();
    }
  }, [events]);

  const visibleEvents = useMemo(
    () => events.filter((e) => filters.has(eventCategory(e.kind))).slice(0, 50),
    [events, filters],
  );

  const toggleFilter = (f: Filter): void => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const toggleExpand = (i: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <PageHeader
        rightSlot={
          <>
            <Link href="/flow" className="text-info text-sm hover:underline">
              ▶ Run a loan
            </Link>
            <Link href="/transactions" className="text-info text-sm hover:underline">
              Transactions
            </Link>
          </>
        }
      />


      <Section title="System pulse">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Ticker label="Loans funded today" value={stats?.loansToday} />
          <Ticker
            label="Default rate (24h)"
            value={stats === null ? null : fmtPct(stats.defaultRate24h)}
            tone={
              stats && stats.defaultRate24h > 0.2
                ? "danger"
                : stats && stats.defaultRate24h > 0
                  ? "warn"
                  : "accent"
            }
          />
          <Ticker
            label="USDC volume settled"
            value={
              stats === null ? null : <USDC amount={stats.volumeUsdcSettled} />
            }
          />
          <Ticker label="Active borrowers" value={stats?.activeBorrowers} />
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mt-8">
        <div className="lg:col-span-3 space-y-3">
          <Section
            title="Live activity feed"
            rightSlot={
              <div className="flex gap-2">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    onClick={() => toggleFilter(f)}
                    className={`px-2 py-0.5 rounded text-xs font-mono-tight border transition-colors ${
                      filters.has(f)
                        ? "bg-accent-soft text-accent border-accent/40"
                        : "bg-panel-cardHover text-ink-dim border-panel-border hover:text-ink"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            }
          >
            <Card>
              {visibleEvents.length === 0 ? (
                <div className="p-12 text-center text-ink-dimmer font-mono-tight text-sm">
                  No events yet. Run a loan from{" "}
                  <Link href="/flow" className="text-info hover:underline">
                    /flow
                  </Link>{" "}
                  to populate.
                </div>
              ) : (
                <ul className="font-mono-tight text-xs">
                  {visibleEvents.map((e, i) => (
                    <li
                      key={i}
                      className="border-b border-panel-border last:border-b-0"
                    >
                      <button
                        onClick={() => toggleExpand(i)}
                        className="w-full px-3 py-1.5 flex items-baseline gap-3 text-left hover:bg-panel-cardHover"
                      >
                        <span className="text-ink-dimmer tabular-nums">
                          {fmtTime(new Date(e.ts))}
                        </span>
                        <span
                          className={`${KIND_COLOR[e.kind] ?? "text-ink-dim"} w-3`}
                        >
                          {KIND_ICON[e.kind] ?? "•"}
                        </span>
                        <span className="text-ink-dim w-32 flex-shrink-0">
                          {e.kind}
                        </span>
                        <span className="text-ink truncate flex-1">
                          {summarize(e)}
                        </span>
                        <span className="text-ink-dimmer">
                          {expanded.has(i) ? "▾" : "▸"}
                        </span>
                      </button>
                      {expanded.has(i) && (
                        <pre className="px-3 pb-2 text-[11px] text-ink-dim overflow-x-auto">
                          {JSON.stringify(e, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>
        </div>

        <div className="lg:col-span-2 space-y-3">
          <Section title="Borrower roster">
            <div className="space-y-3">
              {KNOWN_BORROWERS.map((id) => {
                const a = agents[id];
                if (!a) return null;
                return <BorrowerCard key={id} agent={a} />;
              })}
              {Object.keys(agents).length === 0 && (
                <Card className="p-6 text-center text-ink-dimmer font-mono-tight text-xs">
                  No borrowers registered yet.
                </Card>
              )}
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Ticker({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string | null | undefined | React.ReactNode;
  tone?: "default" | "accent" | "warn" | "danger";
}) {
  const toneCls: Record<string, string> = {
    default: "text-ink",
    accent: "text-accent",
    warn: "text-warn",
    danger: "text-danger",
  };
  const empty = value === null || value === undefined;
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
        {label}
      </div>
      <div className={`text-2xl font-mono-tight tabular-nums ${toneCls[tone]}`}>
        {empty ? (
          "—"
        ) : typeof value === "number" ? (
          value.toLocaleString()
        ) : (
          value
        )}
      </div>
    </Card>
  );
}

function BorrowerCard({ agent }: { agent: AgentResponse }) {
  const b = agent.borrower;
  const tier = tierFor(b.score);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <Link
          href={`/agents/${b.borrowerId}`}
          className="text-accent font-mono-tight hover:underline"
        >
          {b.borrowerId}
        </Link>
        <StatusPill status={b.status} />
      </div>
      <TxHash hash={b.walletAddress} />
      <div className="flex items-baseline gap-3 pt-2 border-t border-panel-border">
        <span className="text-3xl font-mono-tight tabular-nums">{b.score}</span>
        <Tag variant="accent">{tier}</Tag>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs font-mono-tight">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">
            limit
          </div>
          <USDC amount={b.limit} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">
            outstanding
          </div>
          <USDC amount={b.outstanding} />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">
            defaults
          </div>
          <span className={b.defaultCount > 0 ? "text-danger" : "text-ink"}>
            {b.defaultCount}
          </span>
        </div>
      </div>
      <Link
        href={`/agents/${b.borrowerId}`}
        className="text-info text-xs hover:underline block pt-1"
      >
        → View agent
      </Link>
    </Card>
  );
}
