"use client";

// Tasks dashboard — vertical FEED of glass cards (no HTML table). Each
// card shows agent + status + amount + a 5-segment lifecycle progress
// bar. Filter changes animate via AnimatePresence.

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { forwardRef, useEffect, useMemo, useState } from "react";
import { ArrowRight, Inbox, SearchX } from "lucide-react";
import { credit } from "../../lib/credit-client";
import { fmtRelative } from "../../lib/format";
import { useCreditEvents } from "../../lib/sse";
import { Skeleton, USDC } from "../../components/ui";
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

const STATUS_TONE: Record<
  TaskStatus,
  { bg: string; border: string; text: string }
> = {
  DRAFT: {
    bg: "bg-warn/10",
    border: "border-warn/40",
    text: "text-warn",
  },
  PAID: { bg: "bg-info/10", border: "border-info/40", text: "text-info" },
  DISPATCHED: {
    bg: "bg-info/10",
    border: "border-info/40",
    text: "text-info",
  },
  PROCESSING: {
    bg: "bg-info/10",
    border: "border-info/40",
    text: "text-info",
  },
  DELIVERED: {
    bg: "bg-info/10",
    border: "border-info/40",
    text: "text-info",
  },
  RELEASED: {
    bg: "bg-accent/10",
    border: "border-accent/40",
    text: "text-accent",
  },
  FAILED: {
    bg: "bg-danger/10",
    border: "border-danger/40",
    text: "text-danger",
  },
  REFUNDED: {
    bg: "bg-white/[0.04]",
    border: "border-white/15",
    text: "text-ink-dim",
  },
  EXPIRED: {
    bg: "bg-white/[0.04]",
    border: "border-white/15",
    text: "text-ink-dim",
  },
};

// 5-segment lifecycle bar. Indexes give "current" stage from status.
const LIFECYCLE_STAGES = [
  "DRAFT",
  "PAID",
  "DISPATCHED",
  "DELIVERED",
  "RELEASED",
] as const;

function stageIndex(status: TaskStatus): number {
  if (status === "DRAFT") return 0;
  if (status === "PAID") return 1;
  if (status === "DISPATCHED" || status === "PROCESSING") return 2;
  if (status === "DELIVERED") return 3;
  if (status === "RELEASED") return 4;
  // failed/refunded/expired show as full red bar
  return -1;
}

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const { events } = useCreditEvents();

  useEffect(() => {
    credit
      .getAgentRegistry()
      .then((r) => setAgents(r.agents))
      .catch(() => {
        /* ignore */
      });
  }, []);

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
        setLoadError(null);
      } catch (err) {
        // Backend offline / network blip / CORS — surface a friendly
        // error and stop the unhandled-promise-rejection warning.
        console.error("[tasks] failed to load:", err);
        setLoadError(
          err instanceof Error ? err.message : "Unknown error",
        );
      } finally {
        setLoading(false);
      }
    };
  }, [statusFilter, agentFilter, pageSize, offset]);

  useEffect(() => {
    // Swallow any leak that escapes the try/catch above so React
    // doesn't log "Unhandled Promise Rejection" if `refetch` itself
    // throws synchronously before the try.
    refetch().catch((err) => {
      console.error("[tasks] refetch threw:", err);
    });
  }, [refetch]);

  const lastRefetchRef = useThrottleRef();
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    if (!last.kind.startsWith("task.")) return;
    if (lastRefetchRef.recently()) return;
    lastRefetchRef.mark();
    refetch().catch((err) => {
      console.error("[tasks] sse-driven refetch threw:", err);
    });
  }, [events, refetch, lastRefetchRef]);

  const agentMap = useMemo(() => {
    const m: Record<string, AgentRegistryEntry> = {};
    agents.forEach((a) => (m[a.agentId] = a));
    return m;
  }, [agents]);

  function clearFilters() {
    setStatusFilter("all");
    setAgentFilter("all");
    setOffset(0);
  }

  return (
    <>
      <PageHeader />
      <motion.main
        className="min-h-screen relative"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="max-w-7xl mx-auto px-6 py-16">
          <header className="mb-12">
            <div className="text-eyebrow mb-3">Activity · escrow lifecycle</div>
            <h1 className="text-display text-white mb-5">
              Activity <em>log.</em>
            </h1>
            <p className="text-body max-w-2xl">
              Every task, every settlement, every refund.{" "}
              <span className="text-mono-micro normal-case">
                {total.toLocaleString()} total · live updates via SSE
              </span>
            </p>
          </header>

      {/* Filters — glass pills with hover glow */}
      <div className="space-y-3 mb-6">
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
              <span className="mr-1" aria-hidden>
                {a.emoji}
              </span>
              {a.displayName}
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

      <div className="text-[11px] uppercase tracking-widest text-ink-dim font-mono-tight mb-3">
        {loading && tasks.length === 0
          ? "Loading…"
          : `${tasks.length} of ${total}`}
      </div>

      {/* Inline error state — visible only after a failed fetch. */}
      {loadError && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-8 text-center mb-3">
          <div className="text-sm text-red-400 mb-2">
            Couldn&apos;t load tasks
          </div>
          <div className="text-xs text-gray-500 mb-4 font-mono-tight">
            {loadError}
          </div>
          <button
            onClick={() => {
              setLoadError(null);
              refetch().catch((err) => {
                console.error("[tasks] manual retry threw:", err);
              });
            }}
            className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Try again →
          </button>
        </div>
      )}

      {/* Feed of cards */}
      <div className="space-y-3">
        <AnimatePresence mode="popLayout">
          {loading && tasks.length === 0 ? (
            <motion.div
              key="loading-skel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              {Array.from({ length: 5 }).map((_, i) => (
                <TaskFeedSkeleton key={i} />
              ))}
            </motion.div>
          ) : tasks.length === 0 && !loading ? (
            <EmptyState
              key="empty"
              filtered={statusFilter !== "all" || agentFilter !== "all"}
              onClear={clearFilters}
            />
          ) : (
            tasks.map((t, i) => (
              <TaskFeedCard
                key={t.taskId}
                task={t}
                agent={agentMap[t.agentId]}
                index={i}
              />
            ))
          )}
        </AnimatePresence>
      </div>

      {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between mt-6 text-sm font-mono-tight">
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
        </div>
      </motion.main>
    </>
  );
}

interface TaskFeedCardProps {
  task: TaskRow;
  agent: AgentRegistryEntry | undefined;
  index: number;
}

// Wrapped in forwardRef so AnimatePresence (mode="popLayout") can
// attach a ref to track mount/unmount without warning.
const TaskFeedCard = forwardRef<HTMLDivElement, TaskFeedCardProps>(
  function TaskFeedCard({ task, agent, index }, ref) {
  const tone = STATUS_TONE[task.status];
  const sIdx = stageIndex(task.status);
  const isFailed =
    task.status === "FAILED" ||
    task.status === "REFUNDED" ||
    task.status === "EXPIRED";

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{
        delay: Math.min(index * 0.04, 0.3),
        duration: 0.4,
        ease: "easeOut",
      }}
    >
      <Link
        href={`/tasks/${encodeURIComponent(task.taskId)}`}
        className="group block rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl px-5 py-4 hover:border-accent/40 hover:-translate-y-0.5 hover:shadow-[0_0_30px_rgba(16,185,129,0.10)] transition-all duration-300"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-2xl flex-shrink-0" aria-hidden>
              {agent?.emoji ?? "🤖"}
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-accent font-mono-tight font-semibold">
                  {task.taskId}
                </span>
                <span className="text-sm font-medium text-ink truncate">
                  {agent?.displayName ?? task.agentId}
                </span>
              </div>
              <div className="text-xs text-ink-dimmer line-clamp-1 mt-0.5">
                {task.input.slice(0, 90)}
                {task.input.length > 90 ? "…" : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[10px] uppercase tracking-widest font-mono-tight ${tone.bg} ${tone.border} ${tone.text}`}
            >
              {STATUS_LABEL[task.status]}
            </span>
            <USDC
              amount={task.pricingUsdc}
              className="text-sm text-accent font-mono-tight tabular-nums font-semibold"
            />
            <motion.span
              className="text-info inline-flex"
              animate={{ x: 0 }}
              whileHover={{ x: 0 }}
            >
              <span className="group-hover:translate-x-1 transition-transform inline-flex">
                <ArrowRight size={16} />
              </span>
            </motion.span>
          </div>
        </div>

        {/* Lifecycle progress bar */}
        <div className="mt-4 flex items-center gap-1.5">
          {LIFECYCLE_STAGES.map((stage, i) => {
            const reached = !isFailed && sIdx >= 0 && i <= sIdx;
            const current = !isFailed && sIdx >= 0 && i === sIdx && sIdx < 4;
            const fillCls = isFailed
              ? "bg-danger/70"
              : reached
                ? "bg-accent"
                : "bg-white/10";
            return (
              <div
                key={stage}
                className="flex-1 flex flex-col items-center gap-1"
              >
                <div
                  className={`h-1.5 w-full rounded-full ${fillCls} ${
                    current ? "animate-pulse" : ""
                  }`}
                  style={{
                    boxShadow: current
                      ? "0 0 12px rgba(16,185,129,0.6)"
                      : undefined,
                  }}
                />
                <span
                  className={`text-[9px] uppercase tracking-widest font-mono-tight ${
                    current
                      ? "text-accent"
                      : reached
                        ? "text-ink-dim"
                        : "text-ink-dimmer/60"
                  }`}
                >
                  {stage}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-ink-dimmer font-mono-tight">
          <span>{fmtRelative(task.createdAt)}</span>
          {isFailed && (
            <span className="text-danger uppercase tracking-widest">
              {STATUS_LABEL[task.status]}
            </span>
          )}
        </div>
      </Link>
    </motion.div>
  );
  },
);
TaskFeedCard.displayName = "TaskFeedCard";

// Skeleton row — matches the shape of TaskFeedCard so the layout
// doesn't reflow when real data lands. Pulse via shared shimmer class.
function TaskFeedSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl px-5 py-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Skeleton className="w-9 h-9" rounded="full" />
          <div className="flex-1 space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Skeleton className="w-16 h-3" />
              <Skeleton className="w-32 h-3" />
            </div>
            <Skeleton className="w-full max-w-md h-2.5" />
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <Skeleton className="w-24 h-5" rounded="full" />
          <Skeleton className="w-16 h-4" />
          <Skeleton className="w-4 h-4" rounded="sm" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <Skeleton className="h-1.5 w-full" rounded="full" />
            <Skeleton className="h-2 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  filtered: boolean;
  onClear: () => void;
}

// AnimatePresence (mode="popLayout") attaches a ref to its immediate
// child; function components can't accept refs without forwardRef.
const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  function EmptyState({ filtered, onClear }, ref) {
  const Icon = filtered ? SearchX : Inbox;
  return (
    <motion.div
      ref={ref}
      key="empty-state"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-12 text-center"
    >
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white/5 mb-4">
        <Icon size={26} className="text-ink-dim" />
      </div>
      <p className="text-sm text-ink-dim mb-3">
        {filtered
          ? "No tasks match your filters."
          : "No tasks yet — submit one from the marketplace."}
      </p>
      {filtered ? (
        <button
          onClick={onClear}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium bg-accent/10 border border-accent/40 text-accent hover:bg-accent/20 transition-colors"
        >
          Clear filters
        </button>
      ) : (
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium bg-accent text-black hover:bg-accent-dim transition-colors"
        >
          Browse marketplace <ArrowRight size={14} />
        </Link>
      )}
    </motion.div>
  );
  },
);
EmptyState.displayName = "EmptyState";

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
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.94 }}
      className={`px-3 py-1 rounded-full text-xs font-mono-tight border backdrop-blur transition-colors duration-200 ${
        active
          ? "bg-accent/15 text-accent border-accent/50 shadow-[0_0_18px_rgba(16,185,129,0.18)]"
          : "bg-white/[0.03] text-ink-dim border-white/10 hover:text-ink hover:border-white/30 hover:bg-white/[0.06]"
      }`}
    >
      {children}
    </motion.button>
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

