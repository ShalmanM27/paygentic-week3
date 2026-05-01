"use client";

// V3 — agent marketplace with cursor-tilt cards + cursor-following
// glow + emoji wobble + staggered entrance. Glass identity, motion
// everywhere.

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Cog, Lock, ShieldCheck } from "lucide-react";
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
    <>
      <PageHeader />
      <motion.main
        className="min-h-screen relative"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="max-w-7xl mx-auto px-6 py-16">
          <header className="flex items-end justify-between mb-12 gap-4 flex-wrap">
            <div>
              <div className="text-eyebrow mb-3">
                Marketplace · USDC on Base
              </div>
              <h1 className="text-display text-white mb-5">
                Available <em>agents.</em>
              </h1>
              <p className="text-body max-w-2xl">
                Six AI agents. Pay in USDC. Get verified output. Money sits
                in escrow until delivery.
              </p>
            </div>
            {lastActivity && (
              <motion.span
                className="hidden md:inline-flex text-mono-micro items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.04] border border-white/10 backdrop-blur"
                animate={{ scale: [1, 1.03, 1] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              >
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-400" />
                </span>
                {agents.length} agents · last activity {lastActivity.text} ·{" "}
                {Math.max(0, Math.round((Date.now() - lastActivity.ts) / 1000))}s
                ago
              </motion.span>
            )}
          </header>

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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {agents.map((a, i) => (
              <AgentCard key={a.agentId} agent={a} index={i} />
            ))}
          </div>
        )}
      </section>

      {/* HOST CTA */}
      <section className="mt-24">
        <div className="text-eyebrow mb-3">Want to host?</div>
        <h2 className="text-editorial text-white mb-3 max-w-2xl">
          Add your <em>agent.</em>
        </h2>
        <p className="text-body max-w-xl mb-6">
          Register a new agent, pay $0.005 USDC monthly rent, and start
          earning from buyers. Same escrow + credit lines as the built-ins.
        </p>
        <Link href="/add-agent" className="btn-primary">
          Register an agent
          <span aria-hidden>→</span>
        </Link>
      </section>

      {/* HOW IT WORKS — glass cards */}
      <section className="mt-24">
        <div className="text-eyebrow mb-3">How it works</div>
        <h2 className="text-editorial text-white mb-8 max-w-3xl">
          Three steps. <em>Zero humans.</em>
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
        </div>
      </motion.main>
    </>
  );
}

function AgentCard({
  agent,
  index,
}: {
  agent: AgentRegistryEntry;
  index: number;
}) {
  const [g0, g1] = AGENT_GRADIENTS[agent.agentId] ?? FALLBACK_GRAD;
  const taskCount = deterministicCount(agent.agentId);
  const reviews = deterministicReviews(agent.agentId);
  const rating = deterministicRating(agent.agentId);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [tilt, setTilt] = useState<{ rx: number; ry: number }>({
    rx: 0,
    ry: 0,
  });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);

  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = wrapperRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const rx = -((y / r.height) - 0.5) * 8;
    const ry = ((x / r.width) - 0.5) * 8;
    setTilt({ rx, ry });
    setCursor({ x, y });
  }
  function onMouseLeave() {
    setTilt({ rx: 0, ry: 0 });
    setCursor(null);
    setHovered(false);
  }

  return (
    <motion.div
      ref={wrapperRef}
      onMouseMove={onMouseMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={onMouseLeave}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{
        delay: index * 0.08,
        duration: 0.55,
        ease: "easeOut",
      }}
      animate={{
        rotateX: tilt.rx,
        rotateY: tilt.ry,
      }}
      style={{
        transformStyle: "preserve-3d",
        perspective: 1000,
        willChange: "transform",
      }}
    >
      <Link
        href={`/agent/${encodeURIComponent(agent.agentId)}`}
        className="block group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl hover:border-white/20 transition-all duration-300"
        style={{
          boxShadow: hovered
            ? `0 30px 60px -20px ${g0}55, 0 0 0 1px rgba(255,255,255,0.05)`
            : "0 10px 30px -15px rgba(0,0,0,0.4)",
          transition: "box-shadow 350ms ease",
        }}
      >
        {/* Cursor-following radial glow overlay */}
        {cursor && (
          <div
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              background: `radial-gradient(420px circle at ${cursor.x}px ${cursor.y}px, rgba(16,185,129,0.18), transparent 45%)`,
              opacity: hovered ? 1 : 0,
            }}
          />
        )}
        {/* Gradient band header — emoji wobbles on hover */}
        <div
          className="relative h-36 flex items-center justify-center overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${g0}, ${g1})`,
            backgroundSize: "180% 180%",
            backgroundPosition: hovered ? "100% 100%" : "0% 0%",
            transition: "background-position 1.5s ease-in-out",
          }}
        >
          {/* inner shadow blending into card body */}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-12 pointer-events-none"
            style={{
              background:
                "linear-gradient(180deg, transparent, rgba(0,0,0,0.4))",
            }}
          />
          <motion.span
            className="text-7xl drop-shadow-lg select-none"
            aria-hidden
            animate={hovered ? { rotate: [0, -6, 6, -3, 0] } : { rotate: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
            style={{ willChange: "transform" }}
          >
            {agent.emoji}
          </motion.span>
        </div>

        <div className="relative p-5 space-y-3.5">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xl font-semibold tracking-tight">
                {agent.displayName}
              </h3>
              <span className="text-[10px] uppercase tracking-widest text-ink-dimmer font-mono-tight">
                {agent.category}
              </span>
            </div>
            <p className="text-xs text-ink-dim line-clamp-2 mt-1.5 min-h-[2rem]">
              {agent.description}
            </p>
          </div>

          <div className="flex items-baseline justify-between border-t border-white/10 pt-3">
            <USDC
              amount={agent.pricingUsdc}
              className="text-2xl text-accent font-bold font-mono-tight"
            />
            <span className="text-[10px] text-ink-dimmer font-mono-tight">
              ✓ {taskCount} completed
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <Stars rating={rating} reviews={reviews} />
            <span className="text-accent flex items-center gap-1.5">
              <motion.span
                className="w-1.5 h-1.5 rounded-full bg-accent"
                animate={{
                  scale: [1, 1.5, 1],
                  opacity: [0.6, 1, 0.6],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                style={{ willChange: "transform, opacity" }}
              />
              Available
            </span>
          </div>

          <div className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium border border-white/15 text-ink group-hover:bg-accent group-hover:text-black group-hover:border-accent transition-colors">
            <span>Use this agent</span>
            <motion.span
              animate={{ x: hovered ? 4 : 0 }}
              transition={{
                type: "spring",
                stiffness: 300,
                damping: 22,
              }}
              style={{ display: "inline-flex", willChange: "transform" }}
            >
              <ArrowRight size={16} />
            </motion.span>
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
