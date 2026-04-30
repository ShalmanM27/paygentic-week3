"use client";

// Tasks dashboard: filter chips, paginated table.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { credit } from "../../lib/credit-client";
import { fmtRelative } from "../../lib/format";
import { useCreditEvents } from "../../lib/sse";
import { Card, Section, Tag, USDC } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import type {
  AgentRegistryEntry,
  TaskRow,
  TaskStatus,
} from "../../lib/types";

type StatusFilter = "all" | "awaiting" | "in_progress" | "completed" | "failed";
type AgentFilter = "all" | string;

const STATUS_GROUPS: Record<Exclude<StatusFilter, "all">, TaskStatus[]> = {
  awaiting: ["DRAFT"],
  in_progress: ["PAID", "DISPATCHED", "PROCESSING", "DELIVERED"],
  completed: ["RELEASED"],
  failed: ["FAILED", "REFUNDED", "EXPIRED"],
};

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "awaiting", label: "Awaiting payment" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed / Refunded" },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  DRAFT: "Awaiting payment",
  PAID: "Paid",
  DISPATCHED: "Dispatched",
  PROCESSING: "Processing",
  DELIVERED: "Delivered",
  RELEASED: "Released",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  EXPIRED: "Expired",
};

const STATUS_VARIANT: Record<TaskStatus, "default" | "accent" | "warn" | "danger" | "info"> = {
  DRAFT: "warn",
  PAID: "info",
  DISPATCHED: "info",
  PROCESSING: "info",
  DELIVERED: "info",
  RELEASED: "accent",
  FAILED: "danger",
  REFUNDED: "default",
  EXPIRED: "default",
};

export default function TasksDashboard() {
  const [agents, setAgents] = useState<AgentRegistryEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20);
  const [offset, setOffset] = useState(0);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const { events } = useCreditEvents();

  useEffect(() => {
    credit
      .getAgentRegistry()
      .then((r) => setAgents(r.agents))
      .catch(() => {
        /* ignore */
      });
  }, []);

  // The /tasks API filters by a single status, not a group. To support the
  // grouped chip ("In progress" → 4 statuses), we fetch each member status
  // and merge. For "all" we fetch with no status filter.
  const refetch = useMemo(() => {
    return async () => {
      setLoading(true);
      try {
        if (statusFilter === "all") {
          const res = await credit.listTasks({
            ...(agentFilter !== "all" ? { agentId: agentFilter } : {}),
            limit: pageSize,
            offset,
          });
          setTasks(res.tasks);
          setTotal(res.pagination.total);
          setHasMore(res.pagination.hasMore);
        } else {
          const statuses = STATUS_GROUPS[statusFilter];
          // Fetch up to pageSize from each, merge, sort, slice.
          const responses = await Promise.all(
            statuses.map((s) =>
              credit.listTasks({
                status: s,
                ...(agentFilter !== "all" ? { agentId: agentFilter } : {}),
                limit: pageSize + offset,
                offset: 0,
              }),
            ),
          );
          const merged = responses
            .flatMap((r) => r.tasks)
            .sort((a, b) => {
              const at = a.createdAt ? Date.parse(a.createdAt) : 0;
              const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
              return bt - at;
            });
          const totalCount = responses.reduce(
            (s, r) => s + r.pagination.total,
            0,
          );
          const slice = merged.slice(offset, offset + pageSize);
          setTasks(slice);
          setTotal(totalCount);
          setHasMore(offset + slice.length < totalCount);
        }
      } finally {
        setLoading(false);
      }
    };
  }, [statusFilter, agentFilter, pageSize, offset]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Refetch on any task.* SSE event (debounced via micro-throttle).
  const lastRefetchRef = useThrottleRef();
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    if (!last.kind.startsWith("task.")) return;
    if (lastRefetchRef.recently()) return;
    lastRefetchRef.mark();
    refetch();
  }, [events, refetch, lastRefetchRef]);

  const agentEmoji = useMemo(() => {
    const m: Record<string, AgentRegistryEntry> = {};
    agents.forEach((a) => (m[a.agentId] = a));
    return m;
  }, [agents]);

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <PageHeader
        crumbs={[
          { href: "/", label: "Marketplace" },
          { label: "Tasks" },
        ]}
      />

      <header className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.25em] text-accent font-semibold mb-2">
          Tasks · escrow lifecycle
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
          <span className="bg-gradient-to-r from-accent via-info to-warn bg-clip-text text-transparent">
            Activity log
          </span>
        </h1>
        <p className="text-base text-ink-dim mt-2">
          {total.toLocaleString()} total
        </p>
      </header>

      {/* Filters */}
      <div className="space-y-3 mb-4">
        <ChipRow label="Status">
          {STATUS_CHIPS.map((c) => (
            <Chip
              key={c.key}
              active={statusFilter === c.key}
              onClick={() => {
                setStatusFilter(c.key);
                setOffset(0);
              }}
            >
              {c.label}
            </Chip>
          ))}
        </ChipRow>
        <ChipRow label="Agent">
          <Chip
            active={agentFilter === "all"}
            onClick={() => {
              setAgentFilter("all");
              setOffset(0);
            }}
          >
            All
          </Chip>
          {agents.map((a) => (
            <Chip
              key={a.agentId}
              active={agentFilter === a.agentId}
              onClick={() => {
                setAgentFilter(a.agentId);
                setOffset(0);
              }}
            >
              {a.emoji} {a.displayName}
            </Chip>
          ))}
        </ChipRow>
        <ChipRow label="Per page">
          {([20, 50, 100] as const).map((n) => (
            <Chip
              key={n}
              active={pageSize === n}
              onClick={() => {
                setPageSize(n);
                setOffset(0);
              }}
            >
              {n}
            </Chip>
          ))}
        </ChipRow>
      </div>

      <Section title={loading ? "Loading…" : `${tasks.length} of ${total}`}>
        <Card className="overflow-x-auto">
          {tasks.length === 0 ? (
            <div className="p-12 text-center text-ink-dimmer text-sm">
              No tasks yet.{" "}
              <Link href="/" className="text-info hover:underline">
                Start with an agent on the home page.
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm font-mono-tight">
              <thead>
                <tr className="border-b border-panel-border text-[10px] uppercase tracking-widest text-ink-dim">
                  <th className="text-left font-medium px-3 py-2">Time</th>
                  <th className="text-left font-medium px-3 py-2">Task ID</th>
                  <th className="text-left font-medium px-3 py-2">Agent</th>
                  <th className="text-left font-medium px-3 py-2">Input</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-right font-medium px-3 py-2">Amount</th>
                  <th className="text-right font-medium px-3 py-2">—</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const ag = agentEmoji[t.agentId];
                  return (
                    <tr
                      key={t.taskId}
                      className="border-b border-panel-border last:border-b-0 hover:bg-panel-cardHover/40"
                    >
                      <td className="px-3 py-2 text-ink-dim whitespace-nowrap">
                        {fmtRelative(t.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-accent">{t.taskId}</td>
                      <td className="px-3 py-2">
                        {ag ? (
                          <span>
                            <span className="mr-1" aria-hidden>
                              {ag.emoji}
                            </span>
                            {ag.displayName}
                          </span>
                        ) : (
                          t.agentId
                        )}
                      </td>
                      <td className="px-3 py-2 text-ink-dim max-w-[18rem] truncate">
                        {t.input.slice(0, 60)}
                        {t.input.length > 60 ? "…" : ""}
                      </td>
                      <td className="px-3 py-2">
                        <Tag variant={STATUS_VARIANT[t.status]}>
                          {STATUS_LABEL[t.status]}
                        </Tag>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <USDC amount={t.pricingUsdc} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/tasks/${encodeURIComponent(t.taskId)}`}
                          className="text-info hover:underline"
                        >
                          View →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </Section>

      {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between mt-4 text-sm font-mono-tight">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
            className="text-info disabled:text-ink-dimmer hover:underline disabled:no-underline"
          >
            ← Prev
          </button>
          <span className="text-ink-dimmer">
            offset {offset} – {offset + tasks.length}
          </span>
          <button
            disabled={!hasMore}
            onClick={() => setOffset(offset + pageSize)}
            className="text-info disabled:text-ink-dimmer hover:underline disabled:no-underline"
          >
            Next →
          </button>
        </div>
      )}
    </main>
  );
}

function ChipRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-widest text-ink-dim font-mono-tight w-20">
        {label}
      </span>
      <div className="flex gap-2 flex-wrap">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-0.5 rounded text-xs font-mono-tight border transition-colors ${
        active
          ? "bg-accent-soft text-accent border-accent/40"
          : "bg-panel-cardHover text-ink-dim border-panel-border hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function useThrottleRef(thresholdMs = 500) {
  const ref = useState({ last: 0 })[0];
  return {
    recently(): boolean {
      return Date.now() - ref.last < thresholdMs;
    },
    mark(): void {
      ref.last = Date.now();
    },
  };
}
