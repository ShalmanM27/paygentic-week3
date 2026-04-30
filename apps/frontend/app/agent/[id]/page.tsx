"use client";

// Per-agent storefront. Two-column layout: marketing + try-this-agent form
// on the left; on-chain identity + recent results on the right. Submitting
// the form creates a task and redirects to /tasks/:id where the checkout
// SDK mounts.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { credit } from "../../../lib/credit-client";
import { fmtRelative } from "../../../lib/format";
import {
  Button,
  Card,
  Section,
  Tag,
  TxHash,
  USDC,
} from "../../../components/ui";
import { PageHeader } from "../../../components/PageHeader";
import type {
  AgentRegistryEntry,
  TaskRow,
} from "../../../lib/types";

type AdminAgent = Awaited<ReturnType<typeof credit.getAdminAgent>>;

interface Props {
  params: { id: string };
}

const SERVICE_PORTS: Record<string, number> = {
  summarizer: 4001,
  "code-reviewer": 4002,
  "code-writer": 4004,
};

const CAPABILITIES: Record<string, string[]> = {
  summarizer: [
    "Reads up to 4000 chars of input",
    "Outputs 3–5 bullet points",
    "Powered by Gemini Flash",
  ],
  "code-reviewer": [
    "Reviews any code in any language",
    "Identifies bugs, style issues, security concerns",
    "Returns actionable, structured feedback",
  ],
  "code-writer": [
    "Generates working code from natural-language specs",
    "Includes inline comments for non-obvious logic",
    "Multiple language support",
  ],
};

const PLACEHOLDERS: Record<string, string> = {
  summarizer:
    "Paste a long article, doc, or transcript here. The agent will return 3–5 concise bullet points.",
  "code-reviewer":
    "Paste a code snippet (any language). The agent will identify bugs, style issues, and security concerns.",
  "code-writer":
    "Describe what you want built. e.g. 'A TypeScript function that debounces an async call by 300ms.'",
};

const MIN_INPUT = 10;
const MAX_INPUT = 4000;

export default function AgentDetailPage({ params }: Props) {
  const { id } = params;
  const router = useRouter();
  const [agent, setAgent] = useState<AgentRegistryEntry | null>(null);
  const [adminAgent, setAdminAgent] = useState<AdminAgent | null>(null);
  const [recentTasks, setRecentTasks] = useState<TaskRow[]>([]);
  const [healthy, setHealthy] = useState<boolean | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Form state.
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotFound(false);
    setLoadError(null);
    Promise.all([
      credit.getAgentRegistry(),
      credit.getAdminAgent(id).catch((e) => {
        const status = (e as Error & { status?: number }).status;
        if (status === 404) return null;
        throw e;
      }),
      credit
        .listTasks({ agentId: id, status: "RELEASED", limit: 5 })
        .catch(() => ({ tasks: [], pagination: { total: 0, limit: 5, offset: 0, hasMore: false } })),
    ])
      .then(([reg, ad, tl]) => {
        if (cancelled) return;
        const found = reg.agents.find((a) => a.agentId === id) ?? null;
        if (!found) {
          setNotFound(true);
          return;
        }
        setAgent(found);
        setAdminAgent(ad);
        setRecentTasks(tl.tasks);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    const port = SERVICE_PORTS[agent.agentId];
    if (!port) {
      setHealthy(false);
      return;
    }
    const ping = async (): Promise<void> => {
      try {
        const res = await fetch(`http://localhost:${port}/healthz`, {
          cache: "no-store",
        });
        if (!cancelled) setHealthy(res.ok);
      } catch {
        if (!cancelled) setHealthy(false);
      }
    };
    ping();
    const t = setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agent]);

  const charCount = input.trim().length;
  const tooShort = charCount < MIN_INPUT;
  const tooLong = charCount > MAX_INPUT;
  // Submit blocked when the agent isn't a deployed built-in — placeholder
  // serviceUrls guarantee dispatch failure + 3-attempt refund cycles, which
  // wastes the buyer's $0.0080. We protect them at the gate.
  const submitBlockedByDeployment =
    agent !== null && !agent.isBuiltIn;
  const canSubmit =
    !tooShort && !tooLong && !submitting && !submitBlockedByDeployment;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!agent || !canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await credit.createTask({
        agentId: agent.agentId,
        input: input.trim(),
        ...(email.trim() ? { userIdentifier: email.trim() } : {}),
      });
      router.push(`/tasks/${encodeURIComponent(res.task.taskId)}`);
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (notFound) {
    return (
      <main className="min-h-screen p-12 max-w-3xl mx-auto text-center">
        <PageHeader />
        <p className="text-ink-dim">
          Agent <span className="text-accent">{id}</span> not found in the
          registry.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/" className="text-info hover:underline">
            ← Back to marketplace
          </Link>
        </p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <PageHeader />
        <Card className="p-6 text-danger text-sm">{loadError}</Card>
      </main>
    );
  }

  if (!agent) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <PageHeader />
        <p className="text-ink-dimmer text-sm">Loading agent…</p>
      </main>
    );
  }

  // Capabilities: prefer the registry's per-agent list (X4 — DB-backed);
  // fall back to the hardcoded built-in copy for legacy/built-in agents
  // when registry omits the field.
  const capabilities =
    agent.capabilities && agent.capabilities.length > 0
      ? agent.capabilities
      : (CAPABILITIES[agent.agentId] ?? []);
  const placeholder = PLACEHOLDERS[agent.agentId] ?? "Describe your task…";

  // Operator-registered agents have placeholder serviceUrls and would fail
  // dispatch. Built-ins are the only ones guaranteed to be running.
  // (Future: replace this with `agent.deployedAt != null` once we add a
  // real reachability probe / deployment record.)
  const isAwaitingDeployment = !agent.isBuiltIn;

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <PageHeader
        crumbs={[
          { href: "/", label: "Marketplace" },
          { label: agent.displayName },
        ]}
      />

      {isAwaitingDeployment && (
        <Card className="p-3 mb-4 border-warn/40 bg-warn-soft text-warn text-sm flex items-start gap-3">
          <span aria-hidden>⏳</span>
          <div>
            <div className="font-medium">Awaiting deployment</div>
            <p className="text-xs mt-0.5 text-warn/80">
              This agent is registered but its service endpoint is being
              provisioned. Tasks submitted now may not be fulfilled until the
              operator brings the service online.
            </p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* LEFT — 60% */}
        <div className="lg:col-span-3 space-y-6">
          <header className="flex items-start gap-4 pb-4 border-b border-panel-border">
            <span className="text-5xl leading-none" aria-hidden>
              {agent.emoji}
            </span>
            <div className="flex-1 min-w-0">
              <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
                {agent.displayName}
              </h1>
              <div className="flex items-center gap-2 mt-2">
                <Tag variant="default">{agent.category}</Tag>
                <AvailabilityPill healthy={healthy} />
              </div>
            </div>
          </header>

          <p className="text-ink-dim leading-relaxed">{agent.description}</p>

          <Section title="Capabilities">
            <Card className="p-4">
              <ul className="space-y-2 text-sm">
                {capabilities.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="text-accent">✓</span>
                    <span className="text-ink">{c}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </Section>

          <Section title="Pricing">
            <Card className="p-4 flex items-baseline justify-between">
              <div>
                <USDC
                  amount={agent.pricingUsdc}
                  className="text-3xl text-accent"
                />
                <span className="ml-2 text-sm text-ink-dim">per task</span>
              </div>
              <span className="text-xs text-ink-dimmer">
                Held in escrow until verified delivery
              </span>
            </Card>
          </Section>

          <Section title="Try this agent">
            <Card className="p-5">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    className="block text-xs uppercase tracking-widest text-ink-dim mb-2"
                    htmlFor="task-input"
                  >
                    Your task input
                  </label>
                  <textarea
                    id="task-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={placeholder}
                    rows={8}
                    className="w-full bg-panel-cardHover border border-panel-borderStrong rounded p-3 text-sm font-mono-tight text-ink placeholder:text-ink-dimmer focus:outline-none focus:border-accent/50 resize-y"
                  />
                  <div className="flex justify-between text-[11px] text-ink-dimmer mt-1 font-mono-tight">
                    <span>
                      Min {MIN_INPUT} chars · max {MAX_INPUT.toLocaleString()}
                    </span>
                    <span
                      className={
                        tooLong
                          ? "text-danger"
                          : tooShort && charCount > 0
                            ? "text-warn"
                            : ""
                      }
                    >
                      {charCount} / {MAX_INPUT}
                    </span>
                  </div>
                </div>
                <div>
                  <label
                    className="block text-xs uppercase tracking-widest text-ink-dim mb-2"
                    htmlFor="task-email"
                  >
                    Email (optional, for receipt)
                  </label>
                  <input
                    id="task-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full bg-panel-cardHover border border-panel-borderStrong rounded p-2 text-sm font-mono-tight text-ink placeholder:text-ink-dimmer focus:outline-none focus:border-accent/50"
                  />
                </div>
                {submitError && (
                  <div className="text-sm text-danger">{submitError}</div>
                )}
                <Button
                  type="submit"
                  disabled={!canSubmit}
                  size="lg"
                  className="w-full"
                  title={
                    submitBlockedByDeployment
                      ? "This agent's service endpoint is being provisioned. Try a built-in agent instead."
                      : undefined
                  }
                >
                  {submitting
                    ? "Creating task…"
                    : submitBlockedByDeployment
                      ? "Awaiting deployment"
                      : `Pay $${agent.pricingUsdc.toFixed(4)} & submit task`}
                </Button>
              </form>
              <p className="mt-3 text-[11px] text-ink-dimmer leading-relaxed">
                Funds held in escrow at credit platform. Released to agent on
                verified delivery. Refunded if agent fails or output is
                rejected. Powered by Locus Checkout on Base.
              </p>
            </Card>
          </Section>
        </div>

        {/* RIGHT — 40% */}
        <div className="lg:col-span-2 space-y-4">
          <Section title="About this agent">
            <Card className="p-4 space-y-3 text-sm">
              <Field label="Wallet">
                {adminAgent ? (
                  <TxHash hash={adminAgent.borrower.walletAddress} />
                ) : (
                  <span className="text-ink-dimmer">unregistered</span>
                )}
              </Field>
              <Field label="Lifetime earned">
                <USDC
                  amount={
                    adminAgent
                      ? adminAgent.totals.lifetimeRepaid +
                        // Use repaid as proxy for earned-via-repayment;
                        // actual earnings include releases not tracked yet.
                        0
                      : null
                  }
                />
              </Field>
              <Field label="Score">
                <span className="text-accent font-mono-tight tabular-nums">
                  {adminAgent ? adminAgent.borrower.score : "—"}
                </span>
              </Field>
              <Field label="Active loans">
                <span className="font-mono-tight tabular-nums">
                  {adminAgent ? adminAgent.totals.openLoanCount : "—"}
                </span>
              </Field>
              {adminAgent && (
                <Link
                  href={`/admin/agents/${encodeURIComponent(agent.agentId)}`}
                  className="block text-info text-xs hover:underline pt-2 border-t border-panel-border"
                >
                  → Operator detail
                </Link>
              )}
            </Card>
          </Section>

          <Section title="Recent results">
            <Card>
              {recentTasks.length === 0 ? (
                <div className="p-6 text-sm text-ink-dimmer text-center">
                  No completed tasks yet
                </div>
              ) : (
                <ul className="text-xs">
                  {recentTasks.map((t) => (
                    <li
                      key={t.taskId}
                      className="border-b border-panel-border last:border-b-0"
                    >
                      <Link
                        href={`/tasks/${encodeURIComponent(t.taskId)}`}
                        className="block px-3 py-2 hover:bg-panel-cardHover transition-colors"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="text-accent font-mono-tight">
                            {t.taskId}
                          </span>
                          <span className="text-ink-dimmer">
                            {fmtRelative(t.createdAt)}
                          </span>
                        </div>
                        <p className="text-ink-dim mt-1 truncate">
                          {t.input.slice(0, 80)}
                          {t.input.length > 80 ? "…" : ""}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section title="Hosted by">
            <Card className="p-4 text-sm">
              <div className="font-medium">{agent.operatorName}</div>
              <div className="text-[11px] text-ink-dimmer font-mono-tight mt-1">
                {agent.operatorId}
              </div>
              <p className="text-xs text-ink-dimmer mt-2">
                Multiple agents can be hosted by the same operator.
              </p>
            </Card>
          </Section>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-widest text-ink-dim">
        {label}
      </span>
      <span>{children}</span>
    </div>
  );
}

function AvailabilityPill({ healthy }: { healthy: boolean | undefined }) {
  if (healthy === undefined) {
    return <Tag variant="default">Checking…</Tag>;
  }
  return healthy ? (
    <Tag variant="accent">● Available now</Tag>
  ) : (
    <Tag variant="default">● Paused</Tag>
  );
}

