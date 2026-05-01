"use client";

// Per-task detail. Shows checkout SDK while DRAFT, lifecycle timeline once
// paid, output once delivered, and Locus references throughout. Refetches
// the task on every relevant SSE event for this taskId; polls on a 10s
// fallback if SSE is dead.

import Link from "next/link";
import confetti from "canvas-confetti";
import { useEffect, useMemo, useRef, useState } from "react";
import { credit } from "../../../lib/credit-client";
import { fmtRelative, fmtTime } from "../../../lib/format";
import { useCreditEvents } from "../../../lib/sse";
import {
  Button,
  Card,
  Section,
  SessionId,
  Tag,
  TxHash,
  USDC,
} from "../../../components/ui";
import { PageHeader } from "../../../components/PageHeader";
import { LocusCheckoutMount } from "../../../lib/locus-checkout";
import type {
  AgentRegistryEntry,
  TaskRow,
  TaskStatus,
} from "../../../lib/types";

interface Props {
  params: { taskId: string };
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  DRAFT: "Awaiting payment",
  PAID: "Payment received",
  DISPATCHED: "Sent to agent",
  PROCESSING: "Agent working…",
  DELIVERED: "Output received, verifying",
  RELEASED: "Complete — agent paid",
  FAILED: "Failed verification",
  REFUNDED: "Refunded",
  EXPIRED: "Session expired",
};

const STATUS_VARIANT: Record<
  TaskStatus,
  "default" | "accent" | "warn" | "danger" | "info"
> = {
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

const TIMELINE_BASE: Array<{
  status: TaskStatus | "PROCESSING_OR_BORROW";
  label: string;
}> = [
  { status: "PAID", label: "Paid" },
  { status: "DISPATCHED", label: "Dispatched" },
  { status: "PROCESSING_OR_BORROW", label: "Processing" },
  { status: "DELIVERED", label: "Delivered" },
  { status: "RELEASED", label: "Released" },
];

const STATUS_RANK: Record<TaskStatus, number> = {
  DRAFT: 0,
  PAID: 1,
  DISPATCHED: 2,
  PROCESSING: 3,
  DELIVERED: 4,
  RELEASED: 5,
  FAILED: 99,
  REFUNDED: 99,
  EXPIRED: 99,
};

export default function TaskDetail({ params }: Props) {
  const { taskId } = params;
  const [task, setTask] = useState<TaskRow | null>(null);
  const [agent, setAgent] = useState<AgentRegistryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastFetchRef = useRef(0);
  // Tracks how long the task has been in PROCESSING (or DISPATCHED waiting
  // to flip to PROCESSING). Drives the rotating sub-label on the timeline.
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const processingStartRef = useRef<number | null>(null);
  // Fire confetti exactly once when status flips to RELEASED.
  const confettiFiredRef = useRef(false);
  const { events } = useCreditEvents();

  async function fetchTask(): Promise<void> {
    lastFetchRef.current = Date.now();
    try {
      const r = await credit.getTask(taskId);
      setTask(r.task);
      setAgent(r.agent);
      setNotFound(false);
      setErr(null);
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status === 404) setNotFound(true);
      else setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetchTask();
    // Polling fallback — refetch every 10s if no SSE event lands.
    const t = setInterval(() => {
      if (Date.now() - lastFetchRef.current > 10_000) {
        fetchTask();
      }
    }, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Confetti celebration on first observed RELEASED.
  useEffect(() => {
    if (!task) return;
    if (task.status === "RELEASED" && !confettiFiredRef.current) {
      confettiFiredRef.current = true;
      // Two bursts from each side for richer effect.
      confetti({
        particleCount: 80,
        spread: 75,
        origin: { x: 0.2, y: 0.6 },
        colors: ["#34d399", "#06b6d4", "#a78bfa", "#f59e0b"],
      });
      confetti({
        particleCount: 80,
        spread: 75,
        origin: { x: 0.8, y: 0.6 },
        colors: ["#34d399", "#06b6d4", "#a78bfa", "#f59e0b"],
      });
    }
  }, [task]);

  // Drive the rotating PROCESSING sub-label. Start timer when status flips
  // to DISPATCHED or PROCESSING; reset when it leaves both.
  useEffect(() => {
    if (!task) return;
    const inProcessingPhase =
      task.status === "DISPATCHED" || task.status === "PROCESSING";
    if (inProcessingPhase) {
      if (processingStartRef.current === null) {
        processingStartRef.current = Date.now();
      }
      const tick = (): void => {
        if (processingStartRef.current === null) return;
        setProcessingSeconds(
          Math.floor((Date.now() - processingStartRef.current) / 1000),
        );
      };
      tick();
      const t = setInterval(tick, 1000);
      return () => clearInterval(t);
    }
    processingStartRef.current = null;
    setProcessingSeconds(0);
    return undefined;
  }, [task]);

  // SSE-driven refetch.
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    if (!last.kind.startsWith("task.")) return;
    if ("taskId" in last && last.taskId !== taskId) return;
    fetchTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, taskId]);

  async function simulatePay(): Promise<void> {
    if (!task) return;
    setSimulating(true);
    try {
      await credit.simulatePay(task.escrowSessionId);
      // Watcher will pick up; refresh shortly after.
      setTimeout(() => fetchTask(), 500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSimulating(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <PageHeader />
        <p className="text-ink-dimmer text-sm">Loading task…</p>
      </main>
    );
  }
  if (notFound) {
    return (
      <main className="min-h-screen p-12 max-w-3xl mx-auto text-center">
        <PageHeader />
        <p className="text-ink-dim">
          Task <span className="text-accent">{taskId}</span> not found.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/" className="text-info hover:underline">
            ← Back to marketplace
          </Link>
        </p>
      </main>
    );
  }
  if (err && !task) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <PageHeader />
        <Card className="p-6 text-danger text-sm">{err}</Card>
      </main>
    );
  }
  if (!task) return null;

  const isTerminalFail =
    task.status === "FAILED" ||
    task.status === "REFUNDED" ||
    task.status === "EXPIRED";
  const rank = STATUS_RANK[task.status];

  const copyOutput = (): void => {
    if (!task.output) return;
    navigator.clipboard?.writeText(task.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <PageHeader
        crumbs={[
          { href: "/", label: "Marketplace" },
          {
            href: `/agent/${encodeURIComponent(task.agentId)}`,
            label: agent?.displayName ?? task.agentId,
          },
          { href: "/tasks", label: "Tasks" },
          { label: task.taskId },
        ]}
      />

      <header className="space-y-3 pb-4 border-b border-panel-border mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-mono-tight text-2xl font-semibold tracking-tight text-accent">
              {task.taskId}
            </h1>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {agent && (
                <Tag variant="default">
                  <span className="mr-1" aria-hidden>
                    {agent.emoji}
                  </span>
                  {agent.displayName}
                </Tag>
              )}
              <span className="text-xs text-ink-dimmer font-mono-tight">
                created {fmtRelative(task.createdAt)} ·{" "}
                {fmtTime(task.createdAt)}
              </span>
            </div>
          </div>
          <Tag variant={STATUS_VARIANT[task.status]} className="text-sm">
            {STATUS_LABEL[task.status]}
          </Tag>
        </div>
      </header>

      <Section title="Task input">
        <Card className="p-4">
          <details>
            <summary className="cursor-pointer text-sm text-ink-dim hover:text-ink">
              Show input ({task.input.length} chars)
            </summary>
            <pre className="mt-3 p-3 rounded bg-panel-cardHover text-sm whitespace-pre-wrap break-words font-mono-tight text-ink">
              {task.input}
            </pre>
          </details>
        </Card>
      </Section>

      {task.status === "DRAFT" && (
        <Section title={`Pay $${task.pricingUsdc.toFixed(4)} USDC to escrow`}>
          <Card className="p-4 space-y-4">
            {/* Offline-mode sessions (sess_mock_*) aren't recognized by
             *  the real Locus checkout iframe — the SDK request returns
             *  500. Detect the prefix and skip the embed; the
             *  "Simulate payment" button becomes the primary CTA. */}
            {task.escrowSessionId.startsWith("sess_mock_") ? (
              <div className="rounded-md border border-info/30 bg-info-soft px-4 py-3 text-sm text-ink-dim leading-relaxed">
                <div className="text-info font-medium mb-1">
                  Offline / mock mode
                </div>
                Locus is running in offline mode (no real USDC moves).
                Click <strong className="text-info">Simulate payment</strong>{" "}
                below to mark this escrow as paid and watch the
                lifecycle progress.
              </div>
            ) : (
              <LocusCheckoutMount
                sessionId={task.escrowSessionId}
                mode="embedded"
                onPaid={() => fetchTask()}
                onError={(e) => setErr(e.message)}
                onCancel={() => {
                  /* no-op — user can retry */
                }}
              />
            )}
            <div className="flex items-center justify-between text-xs font-mono-tight pt-3 border-t border-panel-border">
              <SessionId id={task.escrowSessionId} />
              <Button
                variant={
                  task.escrowSessionId.startsWith("sess_mock_")
                    ? "primary"
                    : "secondary"
                }
                size={
                  task.escrowSessionId.startsWith("sess_mock_") ? "lg" : "sm"
                }
                disabled={simulating}
                onClick={simulatePay}
                title="Offline-mode demo helper"
              >
                {simulating
                  ? "Simulating…"
                  : task.escrowSessionId.startsWith("sess_mock_")
                    ? `Simulate payment · $${task.pricingUsdc.toFixed(4)}`
                    : "↳ Simulate payment (offline)"}
              </Button>
            </div>
          </Card>
        </Section>
      )}

      {task.status !== "DRAFT" && task.escrowSessionStatus === "PAID" && (
        <Section title="Payment">
          <Card className="p-4 flex items-center justify-between">
            <span className="flex items-center gap-2 text-accent">
              <span>✓</span>
              <span className="text-sm">Payment received</span>
            </span>
            <TxHash hash={task.escrowTxHash} />
          </Card>
        </Section>
      )}

      {(rank >= 1 || isTerminalFail) && (
        <Section title="Progress">
          <Card>
            <ol>
              {!isTerminalFail &&
                TIMELINE_BASE.map((step, i) => (
                  <TimelineStep
                    key={i}
                    label={step.label}
                    completed={
                      step.status === "PROCESSING_OR_BORROW"
                        ? rank >= 3
                        : rank >= STATUS_RANK[step.status as TaskStatus]
                    }
                    pulsing={
                      step.status === "PROCESSING_OR_BORROW"
                        ? rank === 2 || rank === 3
                        : step.status === task.status
                    }
                    detail={timelineDetail(step.status, task, processingSeconds)}
                  />
                ))}
              {task.status === "FAILED" && (
                <>
                  <TimelineStep
                    label="Paid"
                    completed
                    detail={
                      task.escrowTxHash ? (
                        <TxHash hash={task.escrowTxHash} />
                      ) : null
                    }
                  />
                  <TimelineStep
                    label="Failed verification"
                    completed
                    color="danger"
                    detail={task.verificationNotes ?? undefined}
                  />
                </>
              )}
              {task.status === "REFUNDED" && (
                <TimelineStep
                  label="Refunded"
                  completed
                  color="default"
                  detail={
                    task.escrowRefundTxHash ? (
                      <TxHash hash={task.escrowRefundTxHash} />
                    ) : (
                      "no on-chain refund (cosmetic)"
                    )
                  }
                />
              )}
              {task.status === "EXPIRED" && (
                <TimelineStep
                  label="Escrow session expired"
                  completed
                  color="default"
                  detail="Payer never paid before TTL."
                />
              )}
            </ol>
          </Card>
        </Section>
      )}

      {task.borrowedToFulfill && task.loanId && (
        <Section title="Credit drawn for this task">
          <Card className="p-4 text-sm flex items-center justify-between">
            <div>
              <div className="text-ink-dim text-xs">Loan ID</div>
              <Link
                href={`/admin/agents/${encodeURIComponent(task.agentId)}`}
                className="font-mono-tight text-accent hover:underline"
              >
                {task.loanId}
              </Link>
            </div>
            <span className="text-xs text-ink-dimmer">
              Agent borrowed credit to fulfill, will repay from earnings.
            </span>
          </Card>
        </Section>
      )}

      {task.output && (
        <Section title="Agent output">
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-dimmer">
                {task.modelUsed ? `Generated by ${task.modelUsed}` : "Generated"}{" "}
                · {task.output.length.toLocaleString()} chars
              </span>
              <Button variant="secondary" size="sm" onClick={copyOutput}>
                {copied ? "✓ Copied" : "Copy"}
              </Button>
            </div>
            <pre className="p-3 rounded bg-panel-cardHover text-sm whitespace-pre-wrap break-words font-mono-tight text-ink leading-relaxed">
              {task.output}
            </pre>
          </Card>
        </Section>
      )}

      <Section title="Locus session details">
        <Card className="p-0">
          <details>
            <summary className="cursor-pointer text-sm text-ink-dim hover:text-ink px-4 py-3">
              Show details
            </summary>
            <div className="px-4 pb-4 space-y-3 text-sm font-mono-tight border-t border-panel-border pt-3">
              <KV label="Escrow session">
                <SessionId id={task.escrowSessionId} truncate={false} />
              </KV>
              <KV label="Escrow status">
                <Tag variant="default">{task.escrowSessionStatus}</Tag>
              </KV>
              <KV label="Escrow tx">
                <TxHash hash={task.escrowTxHash} />
              </KV>
              <KV label="Release tx">
                <TxHash hash={task.escrowReleaseTxHash} />
              </KV>
              <KV label="Refund tx">
                <TxHash hash={task.escrowRefundTxHash} />
              </KV>
              <KV label="Payer wallet">
                <TxHash hash={task.payerWalletAddress} />
              </KV>
              <KV label="Pricing">
                <USDC amount={task.pricingUsdc} />
              </KV>
              {task.borrowedToFulfill && (
                <KV label="Linked loan">
                  <span className="text-accent">{task.loanId ?? "—"}</span>
                </KV>
              )}
            </div>
          </details>
        </Card>
      </Section>

      {/* Full-journey strip — at-a-glance footer */}
      <div className="mt-8 mb-4">
        <div className="text-[10px] uppercase tracking-widest text-ink-dimmer font-mono-tight mb-2">
          Full journey
        </div>
        <div className="rounded-lg border border-panel-border bg-panel-card p-3 flex flex-wrap items-center gap-2 text-[11px] font-mono-tight">
          <JourneyBead
            label="Escrow paid"
            on={rank >= 1}
            tone={task.escrowSessionStatus === "PAID" ? "accent" : "default"}
          />
          <JourneySep />
          <JourneyBead
            label="Dispatched"
            on={rank >= 2}
            tone={rank >= 2 ? "accent" : "default"}
          />
          {task.borrowedToFulfill && (
            <>
              <JourneySep />
              <JourneyBead label="Loan funded" on tone="info" />
            </>
          )}
          <JourneySep />
          <JourneyBead
            label="Processing"
            on={rank >= 3}
            tone={rank >= 3 ? "accent" : "default"}
          />
          <JourneySep />
          <JourneyBead
            label="Delivered"
            on={rank >= 4}
            tone={rank >= 4 ? "accent" : "default"}
          />
          <JourneySep />
          {task.status === "RELEASED" && (
            <JourneyBead label="Released ✓" on tone="accent" />
          )}
          {task.status === "FAILED" && (
            <JourneyBead label="Failed ✗" on tone="danger" />
          )}
          {task.status === "REFUNDED" && (
            <JourneyBead label="Refunded ↺" on tone="warn" />
          )}
          {task.status === "EXPIRED" && (
            <JourneyBead label="Expired" on tone="default" />
          )}
          {!isTerminalFail && rank < 5 && (
            <JourneyBead label="Pending release" on={false} tone="default" />
          )}
        </div>
      </div>
    </main>
  );
}

function JourneySep() {
  return <span className="text-ink-dimmer">→</span>;
}

function JourneyBead({
  label,
  on,
  tone,
}: {
  label: string;
  on: boolean;
  tone: "accent" | "info" | "danger" | "warn" | "default";
}) {
  const cls: Record<typeof tone, string> = {
    accent: "bg-accent-soft text-accent border-accent/40",
    info: "bg-info-soft text-info border-info/40",
    danger: "bg-danger-soft text-danger border-danger/40",
    warn: "bg-warn-soft text-warn border-warn/40",
    default: "bg-panel-cardHover text-ink-dimmer border-panel-borderStrong",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${
        on ? cls[tone] : cls.default + " opacity-60"
      }`}
    >
      {label}
    </span>
  );
}

function TimelineStep({
  label,
  completed,
  pulsing = false,
  color = "accent",
  detail,
}: {
  label: string;
  completed: boolean;
  pulsing?: boolean;
  color?: "accent" | "danger" | "default";
  detail?: React.ReactNode;
}) {
  const dotColor =
    !completed
      ? "border-panel-borderStrong bg-transparent"
      : color === "accent"
        ? "border-accent bg-accent"
        : color === "danger"
          ? "border-danger bg-danger"
          : "border-panel-borderStrong bg-panel-borderStrong";
  return (
    <li className="flex items-start gap-3 px-4 py-3 border-b border-panel-border last:border-b-0">
      <span
        className={`w-3 h-3 rounded-full border-2 mt-1 ${dotColor} ${
          pulsing && completed ? "animate-pulse" : ""
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between">
          <span
            className={
              completed
                ? color === "danger"
                  ? "text-danger font-medium"
                  : "text-ink font-medium"
                : "text-ink-dimmer"
            }
          >
            {label}
          </span>
        </div>
        {detail !== undefined && detail !== null && (
          <div className="text-xs text-ink-dim mt-1">{detail}</div>
        )}
      </div>
    </li>
  );
}

function processingLabel(seconds: number, borrowed: boolean): string {
  // Rotating hints — Gemini cold-starts can run 20s+, so reassure the user
  // progressively. Phrasing escalates without alarming.
  if (seconds >= 60) {
    return "This is taking longer than expected. Refresh to check status.";
  }
  if (seconds >= 25) {
    return "Still working — Gemini cold starts can be slow…";
  }
  if (seconds >= 8) {
    return "Generating output (this can take 20–30 seconds)…";
  }
  if (borrowed) return "Agent borrowed to cover work cost — thinking…";
  return "Agent thinking…";
}

function timelineDetail(
  step: TaskStatus | "PROCESSING_OR_BORROW",
  task: TaskRow,
  processingSeconds: number,
): React.ReactNode {
  if (step === "PAID") {
    return task.escrowTxHash ? <TxHash hash={task.escrowTxHash} /> : null;
  }
  if (step === "PROCESSING_OR_BORROW") {
    if (task.status === "PROCESSING" || task.status === "DISPATCHED") {
      return processingLabel(processingSeconds, task.borrowedToFulfill);
    }
    if (task.borrowedToFulfill) return "Agent borrowed to cover work cost.";
    return null;
  }
  if (step === "DELIVERED") {
    if (!task.output) return null;
    return `${task.output.length.toLocaleString()} chars · ${
      task.modelUsed ?? "model"
    }`;
  }
  if (step === "RELEASED") {
    return task.escrowReleaseTxHash ? (
      <TxHash hash={task.escrowReleaseTxHash} />
    ) : null;
  }
  return null;
}

function KV({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-widest text-ink-dim">
        {label}
      </span>
      <span className="text-right">{children}</span>
    </div>
  );
}
