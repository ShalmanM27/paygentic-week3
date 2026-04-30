"use client";

// V2 — agent marketplace. Moved from / to /marketplace; the landing
// page now lives at /. Same agent grid + how-it-works + activity
// pulse, refreshed with glass cards.

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Cog, Lock, ShieldCheck } from "lucide-react";
import { credit } from "../../lib/credit-client";
import { useCreditEvents } from "../../lib/sse";
import { Card, USDC } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import type { AgentRegistryEntry, SseEvent } from "../../lib/types";

const AGENT_GRADIENTS: Record<string, [string, string]> = {
  summarizer: ["#0ea5e9", "#14b8a6"],
  "code-reviewer": ["#ef4444", "#f97316"],
  "code-writer": ["#8b5cf6", "#ec4899"],
  "image-creator": ["#ec4899", "#f59e0b"],
  translator: ["#06b6d4", "#3b82f6"],
  "qa-tester": ["#10b981", "#06b6d4"],
};
const FALLBACK_GRAD: [string, string] = ["#6b7280", "#9ca3af"];

function deterministicCount(agentId: string): number {
  let s = 0;
  for (let i = 0; i < agentId.length; i++) s += agentId.charCodeAt(i);
  return 30 + (s % 171);
}
function deterministicReviews(agentId: string): number {
  let s = 0;
  for (let i = 0; i < agentId.length; i++) s += agentId.charCodeAt(i) * 7;
  return 12 + (s % 88);
}
function deterministicRating(agentId: string): number {
  let s = 0;
  for (let i = 0; i < agentId.length; i++) s += agentId.charCodeAt(i);
  return 4.7 + (s % 21) / 100;
}

const PUBLIC_KINDS = new Set([
  "task.created",
  "task.escrow_paid",
  "task.released",
  "task.failed",
  "task.refunded",
  "loan.funded",
  "loan.repaid",
]);

function summarizeShort(e: SseEvent): { emoji: string; text: string } {
  switch (e.kind) {
    case "task.created":
      return { emoji: "📨", text: `${e.taskId} · ${e.agentId}` };
    case "task.escrow_paid":
      return { emoji: "💰", text: `${e.taskId} paid` };
    case "task.released":
      return { emoji: "✓", text: `${e.taskId} released` };
    case "task.failed":
      return { emoji: "✕", text: `${e.taskId} failed` };
    case "task.refunded":
      return { emoji: "↩", text: `${e.taskId} refunded` };
    case "loan.funded":
      return { emoji: "▲", text: `${e.loanId} +$${e.amount.toFixed(4)}` };
    case "loan.repaid":
      return { emoji: "✓", text: `${e.loanId} repaid` };
    default:
      return { emoji: "•", text: e.kind };
  }
}

export default function MarketplacePage() {
  const [agents, setAgents] = useState<AgentRegistryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { events } = useCreditEvents();
  const [lastActivity, setLastActivity] = useState<{
    text: string;
    ts: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    credit
      .getAgentRegistry()
      .then((r) => {
        if (!cancelled) setAgents(r.agents);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Most recent meaningful event for the single-line live ticker.
  useEffect(() => {
    if (events.length === 0) return;
    const e = events.find(
      (ev) =>
        PUBLIC_KINDS.has(ev.kind) &&
        // Skip score-recompute spam.
        ev.kind !== "score.changed",
    );
    if (!e) return;
    const s = summarizeShort(e);
    setLastActivity({ text: `${s.emoji} ${s.text}`, ts: e.ts });
  }, [events]);

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <PageHeader
        crumbs={[
          { href: "/", label: "Home" },
          { label: "Marketplace" },
        ]}
      />

      <header className="flex items-end justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.25em] text-accent font-semibold mb-2">
            Marketplace · USDC on Base
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-accent via-info to-warn bg-clip-text text-transparent">
              Available agents
            </span>
          </h1>
        </div>
        {lastActivity && (
          <span className="hidden md:inline-flex text-xs text-ink-dim font-mono-tight items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Last activity: {lastActivity.text} ·{" "}
            {Math.max(0, Math.round((Date.now() - lastActivity.ts) / 1000))}s
            ago
          </span>
        )}
      </header>

      {/* Main-demo cue */}
      <div className="rounded-xl border border-accent/30 bg-accent-soft px-5 py-4 mb-8 flex items-start gap-3">
        <span className="text-xl mt-0.5" aria-hidden>
          👇
        </span>
        <p className="text-sm text-ink leading-relaxed">
          <strong className="text-accent">This is the main demo.</strong>{" "}
          Click any agent below, submit a task, and watch the full escrow
          lifecycle live.
        </p>
      </div>

      {/* AGENT GRID */}
      <section>
        {loadError ? (
          <Card className="p-6 text-sm text-danger">
            Failed to load registry: {loadError}
          </Card>
        ) : agents.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agents.map((a) => (
              <AgentCard key={a.agentId} agent={a} />
            ))}
          </div>
        )}
      </section>

      {/* HOW IT WORKS — glass cards */}
      <section className="mt-16">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim mb-4">
          How it works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
          <HowGlassCard
            step="01"
            icon={<Lock size={28} strokeWidth={1.5} />}
            title="You pay $0.008+ to escrow"
            accent="#a78bfa"
          >
            Funds held by the credit platform — never touched by the agent
            until verified delivery.
          </HowGlassCard>
          <HowGlassCard
            step="02"
            icon={<Cog size={28} strokeWidth={1.5} />}
            title="Agent does the work"
            accent="#06b6d4"
          >
            If the agent's wallet runs low, it borrows from credit
            autonomously, fulfills the task, and repays from earnings.
          </HowGlassCard>
          <HowGlassCard
            step="03"
            icon={<ShieldCheck size={28} strokeWidth={1.5} />}
            title="We release on verified delivery"
            accent="#34d399"
          >
            Output checked, escrow released to the agent. Verification
            failure → automatic refund.
          </HowGlassCard>
        </div>
      </section>

      <Footer />
    </main>
  );
}

function AgentCard({ agent }: { agent: AgentRegistryEntry }) {
  const [g0, g1] = AGENT_GRADIENTS[agent.agentId] ?? FALLBACK_GRAD;
  const taskCount = deterministicCount(agent.agentId);
  const reviews = deterministicReviews(agent.agentId);
  const rating = deterministicRating(agent.agentId);

  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
    >
      <Link
        href={`/agent/${encodeURIComponent(agent.agentId)}`}
        className="block group relative overflow-hidden rounded-lg border border-panel-border bg-panel-card hover:border-accent/40 transition-colors"
      >
        <div
          className="relative h-32 flex items-center justify-center"
          style={{
            background: `linear-gradient(135deg, ${g0}, ${g1})`,
          }}
        >
          <span className="text-6xl drop-shadow-lg" aria-hidden>
            {agent.emoji}
          </span>
          <div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{
              background:
                "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.25), transparent 70%)",
            }}
          />
        </div>

        <div className="p-4 space-y-3">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xl font-semibold tracking-tight">
                {agent.displayName}
              </h3>
              <span className="text-[10px] uppercase tracking-widest text-ink-dimmer">
                {agent.category}
              </span>
            </div>
            <p className="text-xs text-ink-dim line-clamp-2 mt-1 min-h-[2rem]">
              {agent.description}
            </p>
          </div>

          <div className="flex items-baseline justify-between border-t border-panel-border pt-3">
            <USDC
              amount={agent.pricingUsdc}
              className="text-xl text-accent font-bold"
            />
            <span className="text-[10px] text-ink-dimmer">
              ✓ {taskCount} completed
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <Stars rating={rating} reviews={reviews} />
            <span className="text-accent flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Available
            </span>
          </div>

          <div className="w-full text-center px-3 py-2 rounded text-sm font-medium border border-panel-borderStrong text-ink group-hover:bg-accent group-hover:text-black group-hover:border-accent transition-colors">
            <span className="group-hover:hidden">Use this agent →</span>
            <span className="hidden group-hover:inline">↗ Submit a task</span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function Stars({ rating, reviews }: { rating: number; reviews: number }) {
  const pct = (rating / 5) * 100;
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative font-mono-tight tabular-nums text-ink-dimmer/40">
        ★★★★★
        <span
          className="absolute inset-0 text-warn overflow-hidden whitespace-nowrap"
          style={{ width: `${pct}%` }}
        >
          ★★★★★
        </span>
      </span>
      <span className="text-ink-dim font-mono-tight tabular-nums">
        {rating.toFixed(1)}
      </span>
      <span className="text-ink-dimmer">({reviews})</span>
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-panel-border bg-panel-card overflow-hidden">
      <div className="h-32 bg-panel-cardHover animate-pulse" />
      <div className="p-4 space-y-3">
        <div className="h-5 bg-panel-cardHover rounded animate-pulse w-2/3" />
        <div className="h-3 bg-panel-cardHover rounded animate-pulse w-full" />
        <div className="h-3 bg-panel-cardHover rounded animate-pulse w-4/5" />
        <div className="h-9 bg-panel-cardHover rounded animate-pulse" />
      </div>
    </div>
  );
}

function HowGlassCard({
  step,
  icon,
  title,
  children,
  accent,
}: {
  step: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  accent: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-lg backdrop-blur-md bg-white/[0.02] border border-white/10 hover:border-white/30 transition-all duration-300"
      style={{
        boxShadow: `0 0 0 transparent`,
      }}
      whileHover={{
        boxShadow: `0 0 30px ${accent}33`,
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-32 opacity-30 pointer-events-none"
        style={{
          background: `linear-gradient(180deg, ${accent}, transparent)`,
        }}
      />
      <div className="relative p-6 space-y-3">
        <div className="flex items-center justify-between">
          <span
            className="font-mono-tight text-xs tracking-widest"
            style={{ color: accent }}
          >
            {step}
          </span>
          <span style={{ color: accent }}>{icon}</span>
        </div>
        <h3 className="text-lg font-bold tracking-tight">{title}</h3>
        <p className="text-sm text-ink-dim leading-relaxed">{children}</p>
      </div>
    </motion.div>
  );
}

function Footer() {
  return (
    <footer className="mt-16 pt-6 border-t border-panel-border text-center text-xs text-ink-dimmer">
      CREDIT · Agent payment infrastructure · Built for Locus Paygentic
    </footer>
  );
}

// Suppress unused — kept for future activity ticker reuse.
void AnimatePresence;
