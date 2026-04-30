"use client";

// V2 — Money flow graph with correct narrative + real data.
//
// 5 nodes: USER (top), BORROWER A (left), CREDIT PLATFORM (center),
// BORROWER B (right), BASE BLOCKCHAIN (bottom).
//
// Animations fire ONLY in response to real triggers (button click +
// SSE events). No idle/random animations.
//
// Each orb is colour-coded by purpose (escrow, loan, repay, release,
// refund) with a label and amount. After landing, a tx-hash chip
// briefly appears below the destination node and a +1 tx pulse fires
// on the BASE node.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronRight,
  ExternalLink,
  FileText,
  Link as LinkIcon,
  Search,
  User,
} from "lucide-react";
import { credit } from "../../../lib/credit-client";
import type { SseEvent } from "../../../lib/types";

// ───────────────────────── Geometry ───────────────────────────────────
const SVG_W = 1000;
const SVG_H = 560;

type NodeId = "user" | "borrower-a" | "borrower-b" | "credit" | "base";

// Round to integers to avoid SSR/CSR hydration mismatches in path d.
const NODE_POS: Record<NodeId, { x: number; y: number; r: number }> = {
  user: { x: Math.round(SVG_W * 0.5), y: Math.round(SVG_H * 0.12), r: 56 },
  "borrower-a": {
    x: Math.round(SVG_W * 0.16),
    y: Math.round(SVG_H * 0.5),
    r: 56,
  },
  credit: { x: Math.round(SVG_W * 0.5), y: Math.round(SVG_H * 0.5), r: 76 },
  "borrower-b": {
    x: Math.round(SVG_W * 0.84),
    y: Math.round(SVG_H * 0.5),
    r: 56,
  },
  base: { x: Math.round(SVG_W * 0.5), y: Math.round(SVG_H * 0.92), r: 36 },
};

const NODE_META: Record<
  NodeId,
  {
    label: string;
    sub: string;
    gradient: [string, string];
  }
> = {
  user: {
    label: "User",
    sub: "Pays escrow upfront",
    gradient: ["#60a5fa", "#3b82f6"],
  },
  "borrower-a": {
    label: "Borrower A",
    sub: "Summarizer",
    gradient: ["#34d399", "#10b981"],
  },
  credit: {
    label: "Credit Platform",
    sub: "🔒 Escrow holder",
    gradient: ["#a78bfa", "#8b5cf6"],
  },
  "borrower-b": {
    label: "Borrower B",
    sub: "Code Reviewer",
    gradient: ["#f59e0b", "#d97706"],
  },
  base: {
    label: "Base",
    sub: "USDC L2",
    gradient: ["#0ea5e9", "#0369a1"],
  },
};

// ───────────────────────── Transfer types ─────────────────────────────
type Purpose =
  | "escrow"
  | "loan"
  | "repay"
  | "release"
  | "refund";

const PURPOSE_STYLE: Record<
  Purpose,
  { color: string; icon: string; label: string }
> = {
  escrow: { color: "#facc15", icon: "🔒", label: "Escrow" },
  loan: { color: "#a78bfa", icon: "💸", label: "Loan" },
  repay: { color: "#a78bfa", icon: "↩", label: "Repay" },
  release: { color: "#34d399", icon: "✓", label: "Release" },
  refund: { color: "#f97316", icon: "↺", label: "Refund" },
};

interface Transfer {
  id: string;
  from: NodeId;
  to: NodeId;
  amount: number;
  purpose: Purpose;
  label: string;
  txHash: string | null;
  startedAt: number;
}

// Each orb takes 2.2s to travel its arc. Combined with the sequential
// queue, a 3-orb happy path takes ~7s end-to-end — readable pacing.
const TRANSFER_DURATION_MS = 2200;

interface TxLogEntry {
  id: string;
  seq: number;
  purpose: Purpose | "default";
  label: string;
  amount: number;
  fromLabel: string;
  toLabel: string;
  sessionId: string | null;
  txHash: string | null;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "BLACKLISTED";
  ts: number;
}

// Deterministic mock hash from any string → 0x + 12 hex chars.
function mockHashFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return "0x" + h.toString(16).padStart(8, "0") + "mock";
}

// ───────────────────────── Curve helpers ──────────────────────────────
function controlPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const cx = SVG_W / 2;
  const cy = SVG_H / 2;
  const dx = mx - cx;
  const dy = my - cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = 70;
  return {
    x: Math.round(mx + (dx / len) * offset),
    y: Math.round(my + (dy / len) * offset),
  };
}

function bezier(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

// ───────────────────────── Event mapping ──────────────────────────────
function eventToTransfer(
  e: SseEvent,
  ctx: { triggeredBorrower: NodeId | null },
): Omit<Transfer, "id" | "startedAt"> | null {
  switch (e.kind) {
    case "session.paid": {
      // Customer paid the borrower's session → in V2 narrative the
      // user's escrow already moved at trigger time; ignore here.
      return null;
    }
    case "loan.funded": {
      const to = borrowerNode(e.borrowerId) ?? ctx.triggeredBorrower;
      if (!to) return null;
      return {
        from: "credit",
        to,
        amount: e.amount,
        purpose: "loan",
        label: `$${e.amount.toFixed(4)} loan`,
        txHash: e.txHash ?? null,
      };
    }
    case "loan.repaid": {
      const from = borrowerNode(e.borrowerId) ?? ctx.triggeredBorrower;
      if (!from) return null;
      return {
        from,
        to: "credit",
        amount: 0,
        purpose: "repay",
        label: "loan repaid",
        txHash: e.txHash ?? null,
      };
    }
    case "loan.defaulted": {
      // Default → trigger refund orb credit→user.
      return {
        from: "credit",
        to: "user",
        amount: 0.008,
        purpose: "refund",
        label: "$0.0080 refund",
        txHash: null,
      };
    }
    case "task.escrow_paid": {
      return {
        from: "user",
        to: "credit",
        amount: 0.008,
        purpose: "escrow",
        label: "$0.0080 escrow",
        txHash: e.txHash ?? null,
      };
    }
    case "task.released": {
      const to = borrowerNode(e.agentId);
      if (!to) return null;
      return {
        from: "credit",
        to,
        amount: 0.008,
        purpose: "release",
        label: "$0.0080 release",
        txHash: e.releaseTxHash ?? null,
      };
    }
    case "task.refunded": {
      return {
        from: "credit",
        to: "user",
        amount: 0.008,
        purpose: "refund",
        label: "$0.0080 refund",
        txHash: null,
      };
    }
    default:
      return null;
  }
}

function borrowerNode(id: string): NodeId | null {
  if (
    id === "agent-a" ||
    id === "summarizer" ||
    id === "code-writer" ||
    id === "translator" ||
    id === "image-creator"
  ) {
    return "borrower-a";
  }
  if (id === "agent-b" || id === "code-reviewer" || id === "qa-tester") {
    return "borrower-b";
  }
  return null;
}

// ───────────────────────── Component ──────────────────────────────────
// V3.2 — fully controlled badges. The parent owns nodeBadges state and
// resets it on Reset Demo. Graph renders strictly from props.
export type NodeBadge =
  | { type: "blacklisted" }
  | { type: "holding"; amount: number };

export interface MoneyFlowGraphProps {
  events: SseEvent[];
  triggeredBorrowerId: string | null;
  /** Fires when the parent clicks Run Loan. We then synthesise the
   *  initial USER → CREDIT escrow orb. */
  triggerToken: number;
  /** Wall-clock ms when the current run started. Older SSE events
   *  (from prior runs) are ignored — prevents the previous scenario's
   *  orbs/badges from re-firing when a new Run Loan is clicked. */
  triggerStartedAt?: number | null;
  /** Controlled badges, keyed by NodeId. Parent clears on reset. */
  nodeBadges: Partial<Record<NodeId, NodeBadge | null>>;
  /** Controlled score-flash signal (set when score drops sharply). */
  scoreFlashNode?: NodeId | null;
}

export function MoneyFlowGraph({
  events,
  triggeredBorrowerId,
  triggerToken,
  triggerStartedAt = null,
  nodeBadges,
  scoreFlashNode = null,
}: MoneyFlowGraphProps) {
  const [mounted, setMounted] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [pulsing, setPulsing] = useState<Set<NodeId>>(new Set());
  const [txLog, setTxLog] = useState<TxLogEntry[]>([]);
  const [recentHashes, setRecentHashes] = useState<
    Array<{ id: string; node: NodeId; hash: string; until: number }>
  >([]);
  // Sequential gate — only one orb in flight at a time. Pending orbs
  // queue and fire after the previous one lands.
  const [orbBusy, setOrbBusy] = useState(false);
  const queueRef = useRef<
    Array<{
      transfer: Omit<Transfer, "id" | "startedAt">;
      sessionId: string | null;
    }>
  >([]);
  // Whether the active borrower is currently "thinking" (between loan
  // disbursement and repayment / between escrow paid and delivery).
  const [thinkingNode, setThinkingNode] = useState<NodeId | null>(null);
  // "+$X net earned" floating notification on a node.
  const [netEarned, setNetEarned] = useState<{
    node: NodeId;
    amount: number;
  } | null>(null);
  // Balance-delta callout (before / after a loan/release lands).
  const [balanceDelta, setBalanceDelta] = useState<{
    node: NodeId;
    before: number;
    after: number;
    label: string;
  } | null>(null);
  const seenEventsRef = useRef<Set<string>>(new Set());
  const transferIdRef = useRef(0);
  const seqRef = useRef(0);

  // Hydration-safe: only render the SVG client-side after mount.
  useEffect(() => setMounted(true), []);

  const triggeredBorrower: NodeId | null = useMemo(() => {
    if (!triggeredBorrowerId) return null;
    return borrowerNode(triggeredBorrowerId);
  }, [triggeredBorrowerId]);

  // Synthesise the initial escrow orb when [Run Loan] is clicked.
  useEffect(() => {
    if (triggerToken === 0 || !triggeredBorrower) return;
    // Reset transient view state on each new run.
    seenEventsRef.current = new Set();
    seqRef.current = 0;
    queueRef.current = [];
    setTxLog([]);
    setRecentHashes([]);
    setThinkingNode(null);
    setNetEarned(null);
    setOrbBusy(false);
    // Enqueue the initial USER → CREDIT escrow orb.
    const sessionId = `escrow-${triggerToken}`;
    enqueueTransfer(
      {
        from: "user",
        to: "credit",
        amount: 0.008,
        purpose: "escrow",
        label: "$0.0080 escrow",
        txHash: mockHashFor(sessionId),
      },
      sessionId,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerToken, triggeredBorrower]);

  // Sequential queue drainer — fires the next orb when the previous
  // one lands. Ensures Step N never starts until Step N−1 finishes.
  useEffect(() => {
    if (orbBusy) return;
    const next = queueRef.current.shift();
    if (!next) return;
    fireTransfer(next.transfer, next.sessionId);
  }, [orbBusy]);

  function enqueueTransfer(
    t: Omit<Transfer, "id" | "startedAt">,
    sessionId: string | null,
  ): void {
    queueRef.current.push({ transfer: t, sessionId });
    // Kick the drainer if idle.
    if (!orbBusy) {
      const head = queueRef.current.shift();
      if (head) fireTransfer(head.transfer, head.sessionId);
    }
  }

  function fireTransfer(
    t: Omit<Transfer, "id" | "startedAt">,
    sessionId: string | null,
  ): void {
    setOrbBusy(true);
    transferIdRef.current += 1;
    const id = `xfer-${transferIdRef.current}`;
    const transfer: Transfer = {
      ...t,
      id,
      startedAt: Date.now(),
    };
    setTransfers((prev) => [...prev, transfer]);

    // After a loan disburses to the agent, show "thinking…" until the
    // next orb (repay or release) lands. Clear thinking on any
    // subsequent agent-side orb.
    if (t.purpose === "loan" && t.to !== "credit") {
      setThinkingNode(t.to);
    } else if (t.purpose === "release" || t.purpose === "repay") {
      setThinkingNode(null);
    }

    seqRef.current += 1;
    const seq = seqRef.current;
    const hash = t.txHash ?? mockHashFor(sessionId ?? id);

    setTxLog((prev) =>
      [
        {
          id,
          seq,
          purpose: t.purpose,
          label: PURPOSE_STYLE[t.purpose].label,
          amount: t.amount,
          fromLabel: NODE_META[t.from].label,
          toLabel: NODE_META[t.to].label,
          sessionId,
          txHash: hash,
          status: "PENDING" as const,
          ts: Date.now(),
        },
        ...prev,
      ].slice(0, 20),
    );

    // After transfer animation completes, mark CONFIRMED, pulse target,
    // briefly show the hash chip, and pulse the BASE chain node.
    setTimeout(() => {
      setTransfers((prev) => prev.filter((x) => x.id !== id));
      setPulsing((prev) => {
        const next = new Set(prev);
        next.add(t.to);
        return next;
      });
      setRecentHashes((prev) => [
        ...prev,
        {
          id,
          node: t.to,
          hash,
          until: Date.now() + 8000,
        },
      ]);
      setTxLog((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, status: "CONFIRMED" as const } : e,
        ),
      );
      // Pulse base chain
      setPulsing((prev) => {
        const next = new Set(prev);
        next.add("base");
        return next;
      });
      setTimeout(() => {
        setPulsing((prev) => {
          const next = new Set(prev);
          next.delete(t.to);
          next.delete("base");
          return next;
        });
      }, 700);

      // After a release orb lands on a borrower, flash "+$X net earned".
      if (t.purpose === "release") {
        setNetEarned({ node: t.to, amount: 0.0049 });
        setTimeout(() => setNetEarned(null), 4000);
      }

      // Balance-delta callout: when a loan lands or a release lands on
      // a borrower, briefly show before → after balance.
      if (t.purpose === "loan" && t.to !== "credit") {
        const idForBal =
          t.to === "borrower-a"
            ? "summarizer"
            : t.to === "borrower-b"
              ? "code-reviewer"
              : null;
        if (idForBal) {
          const before = balances[idForBal] ?? 0;
          const after = before + t.amount;
          setBalanceDelta({
            node: t.to,
            before,
            after,
            label: "credit line",
          });
          setTimeout(() => setBalanceDelta(null), 4000);
        }
      }
      if (t.purpose === "release") {
        const idForBal =
          t.to === "borrower-a"
            ? "summarizer"
            : t.to === "borrower-b"
              ? "code-reviewer"
              : null;
        if (idForBal) {
          const before = balances[idForBal] ?? 0;
          const after = before + t.amount;
          setBalanceDelta({
            node: t.to,
            before,
            after,
            label: "escrow paid",
          });
          setTimeout(() => setBalanceDelta(null), 5000);
        }
      }

      // Escrow-held / blacklist / refund badges are now controlled by
      // the parent via nodeBadges — see /flow/page.tsx SSE handler.

      // Free the gate so the queued next orb can fire.
      setOrbBusy(false);
    }, TRANSFER_DURATION_MS);
  }

  // Convert SSE events → transfers.
  useEffect(() => {
    if (events.length === 0) return;
    if (triggerToken === 0) return;
    events.forEach((e) => {
      // Filter out events from prior runs. Without this, clicking
      // Run B then Run A causes B's loan.funded / loan.defaulted to
      // be re-converted to orbs against borrower-b on the A run.
      if (triggerStartedAt !== null && e.ts < triggerStartedAt) return;

      const key = `${e.ts}:${e.kind}:${
        "sessionId" in e
          ? e.sessionId
          : "loanId" in e
            ? e.loanId
            : "taskId" in e
              ? e.taskId
              : ""
      }`;
      if (seenEventsRef.current.has(key)) return;
      seenEventsRef.current.add(key);

      // Info-level log entries for task lifecycle events that don't
      // map to a money orb (dispatched / processing / delivered). The
      // log should reflect EVERY step of the journey, not just money
      // movements.
      if (
        e.kind === "task.dispatched" ||
        e.kind === "task.processing" ||
        e.kind === "task.delivered"
      ) {
        const taskId = "taskId" in e ? e.taskId : "";
        const labelMap: Record<string, string> = {
          "task.dispatched": "Dispatched to agent",
          "task.processing": "Agent processing",
          "task.delivered": "Output delivered",
        };
        seqRef.current += 1;
        const seq = seqRef.current;
        setTxLog((prev) =>
          [
            {
              id: `info-${seq}-${e.kind}`,
              seq,
              purpose: "default" as const,
              label: labelMap[e.kind] ?? e.kind,
              amount: 0,
              fromLabel: "Credit Platform",
              toLabel: triggeredBorrower
                ? NODE_META[triggeredBorrower].label
                : "Agent",
              sessionId: taskId || null,
              txHash: mockHashFor(`${e.kind}-${taskId}`),
              status: "CONFIRMED" as const,
              ts: Date.now(),
            },
            ...prev,
          ].slice(0, 20),
        );
      }

      // Default handling — append a defaulted log entry. Blacklist
      // and score-flash visuals are now controlled by the parent via
      // nodeBadges + scoreFlashNode props.
      if (e.kind === "loan.defaulted") {
        const node = borrowerNode(e.borrowerId);
        if (node) {
          seqRef.current += 1;
          setTxLog((prev) =>
            [
              {
                id: `default-${seqRef.current}`,
                seq: seqRef.current,
                purpose: "default" as const,
                label: "Loan default",
                amount: 0,
                fromLabel: NODE_META[node].label,
                toLabel: "—",
                sessionId: e.loanId,
                txHash: null,
                status: "FAILED" as const,
                ts: Date.now(),
              },
              ...prev,
            ].slice(0, 20),
          );
        }
      }

      const t = eventToTransfer(e, { triggeredBorrower });
      if (!t) return;

      // On the DEFAULT scenario (Borrower B), suppress any "release"
      // orb. There is no escrow release on a defaulted loan — the
      // user gets refunded, the agent gets nothing. Showing
      // "$0.0080 release" toward Borrower B was misleading.
      const isDefaultRun = triggeredBorrowerId === "agent-b";
      if (isDefaultRun && t.purpose === "release") return;

      const sId =
        "sessionId" in e
          ? e.sessionId
          : "loanId" in e
            ? e.loanId
            : "taskId" in e
              ? e.taskId
              : null;
      enqueueTransfer(t, sId);

      // Happy-path narrative: 500ms after a successful repayment,
      // synthesise the escrow-release orb. NOT for default scenario.
      if (
        !isDefaultRun &&
        e.kind === "loan.repaid" &&
        triggeredBorrower
      ) {
        enqueueTransfer(
          {
            from: "credit",
            to: triggeredBorrower,
            amount: 0.008,
            purpose: "release",
            label: "$0.0080 release",
            txHash: mockHashFor(`release-${e.loanId}`),
          },
          e.loanId,
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Garbage-collect expired hash chips.
  useEffect(() => {
    if (recentHashes.length === 0) return;
    const t = setInterval(() => {
      setRecentHashes((prev) => prev.filter((h) => h.until > Date.now()));
    }, 1000);
    return () => clearInterval(t);
  }, [recentHashes.length]);

  // Poll real balances every 5s.
  useEffect(() => {
    let cancelled = false;
    async function fetchBalances() {
      try {
        const ids = ["summarizer", "code-reviewer"];
        const results = await Promise.all(
          ids.map((id) => credit.getAgentBalance(id).catch(() => null)),
        );
        if (cancelled) return;
        const next: Record<string, number> = {};
        ids.forEach((id, i) => {
          if (results[i]) next[id] = results[i]!.usdcBalance;
        });
        setBalances(next);
      } catch {
        /* ignore */
      }
    }
    fetchBalances();
    const t = setInterval(fetchBalances, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!mounted) {
    return (
      <div className="w-full bg-panel-card border border-panel-border rounded-md p-12 text-center text-ink-dimmer text-sm">
        Loading network…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative w-full bg-panel-card border border-panel-border rounded-md overflow-hidden">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto"
          style={{ maxHeight: 580 }}
        >
          <defs>
            {Object.entries(NODE_META).map(([id, m]) => (
              <radialGradient key={id} id={`grad-${id}`} cx="0.3" cy="0.3" r="0.9">
                <stop offset="0%" stopColor={m.gradient[0]} />
                <stop offset="100%" stopColor={m.gradient[1]} />
              </radialGradient>
            ))}
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="node-shadow"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur in="SourceAlpha" stdDeviation="4" />
              <feOffset dx="0" dy="3" result="offsetblur" />
              <feComponentTransfer>
                <feFuncA type="linear" slope="0.45" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <pattern
              id="dot-grid"
              x="0"
              y="0"
              width="20"
              height="20"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="2" r="1" fill="rgba(255,255,255,0.06)" />
            </pattern>
          </defs>

          {/* Faint dot-grid background */}
          <rect width={SVG_W} height={SVG_H} fill="url(#dot-grid)" />

          <EdgeGuides />

          {/* Active orbs */}
          <AnimatePresence>
            {transfers.map((t) => (
              <CoinOrb key={t.id} transfer={t} />
            ))}
          </AnimatePresence>

          {/* Nodes */}
          {(["user", "borrower-a", "credit", "borrower-b", "base"] as NodeId[]).map(
            (id) => {
              const meta = NODE_META[id];
              const pos = NODE_POS[id];
              const balance =
                id === "borrower-a"
                  ? balances["summarizer"]
                  : id === "borrower-b"
                    ? balances["code-reviewer"]
                    : undefined;
              const badge = nodeBadges[id] ?? null;
              const isBlacklisted = badge?.type === "blacklisted";
              const heldAmount =
                id === "credit" && badge?.type === "holding"
                  ? badge.amount
                  : null;
              return (
                <NodeCircle
                  key={id}
                  id={id}
                  pos={pos}
                  meta={meta}
                  balance={balance}
                  pulsing={pulsing.has(id)}
                  blacklisted={isBlacklisted}
                  scoreFlash={scoreFlashNode === id}
                  escrowHeld={heldAmount}
                  thinking={thinkingNode === id}
                  netEarned={
                    netEarned && netEarned.node === id
                      ? netEarned.amount
                      : null
                  }
                  balanceDelta={
                    balanceDelta && balanceDelta.node === id
                      ? balanceDelta
                      : null
                  }
                />
              );
            },
          )}

          {/* Recent tx-hash chips floating below destination nodes */}
          <AnimatePresence>
            {recentHashes.map((h) => {
              const pos = NODE_POS[h.node];
              return (
                <motion.g
                  key={h.id}
                  initial={{ opacity: 0, y: pos.y + pos.r + 30 }}
                  animate={{ opacity: 1, y: pos.y + pos.r + 50 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                >
                  <foreignObject
                    x={pos.x - 90}
                    y={pos.y + pos.r + 36}
                    width={180}
                    height={30}
                  >
                    <a
                      href={`https://basescan.org/tx/${h.hash}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        background: "rgba(20,20,20,0.95)",
                        border: "1px solid rgba(96,165,250,0.4)",
                        borderRadius: 6,
                        padding: "3px 8px",
                        fontSize: 10,
                        fontFamily: "ui-monospace, monospace",
                        color: "#60a5fa",
                        textDecoration: "none",
                      }}
                    >
                      {h.hash.slice(0, 14)}…
                      <span style={{ opacity: 0.6 }}>↗</span>
                    </a>
                  </foreignObject>
                </motion.g>
              );
            })}
          </AnimatePresence>
        </svg>

        {/* Legend strip */}
        <div className="border-t border-panel-border bg-panel-cardHover/40 px-4 py-2 flex flex-wrap gap-3 text-[11px] font-mono-tight items-center">
          {(Object.entries(PURPOSE_STYLE) as Array<[Purpose, typeof PURPOSE_STYLE[Purpose]]>).map(
            ([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: v.color }}
                />
                <span className="text-ink-dim">{v.icon}</span>
                <span className="text-ink-dim">{v.label}</span>
              </span>
            ),
          )}
        </div>
      </div>

      {/* Transaction log */}
      <TransactionLog entries={txLog} />
    </div>
  );
}

// ───────────────────────── Sub-components ─────────────────────────────

function EdgeGuides() {
  const pairs: Array<[NodeId, NodeId]> = [
    ["user", "credit"],
    ["credit", "borrower-a"],
    ["credit", "borrower-b"],
    ["credit", "base"],
  ];
  return (
    <g opacity="0.1">
      {pairs.map(([a, b], i) => {
        const p0 = NODE_POS[a];
        const p2 = NODE_POS[b];
        const cp = controlPoint(p0, p2);
        const d = `M ${p0.x} ${p0.y} Q ${cp.x} ${cp.y} ${p2.x} ${p2.y}`;
        return (
          <path
            key={i}
            d={d}
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="4 6"
            fill="none"
          />
        );
      })}
    </g>
  );
}

function NodeCircle({
  id,
  pos,
  meta,
  balance,
  pulsing,
  blacklisted,
  scoreFlash,
  escrowHeld,
  thinking = false,
  netEarned = null,
  balanceDelta = null,
}: {
  id: NodeId;
  pos: { x: number; y: number; r: number };
  meta: { label: string; sub: string; gradient: [string, string] };
  balance: number | undefined;
  pulsing: boolean;
  blacklisted: boolean;
  scoreFlash: boolean;
  escrowHeld: number | null;
  thinking?: boolean;
  netEarned?: number | null;
  balanceDelta?: {
    before: number;
    after: number;
    label: string;
  } | null;
}) {
  return (
    <g
      onClick={
        id === "base"
          ? () =>
              window.open(
                "https://basescan.org/address/0xb4474bcb6e1def001cfcd436de1c85046c4b1cbe",
                "_blank",
              )
          : undefined
      }
      style={{ cursor: id === "base" ? "pointer" : "default" }}
    >
      {pulsing && (
        <motion.circle
          cx={pos.x}
          cy={pos.y}
          fill="none"
          stroke={meta.gradient[0]}
          strokeWidth="3"
          initial={{ opacity: 0.8, r: pos.r ?? 50 }}
          animate={{ opacity: 0, r: (pos.r ?? 50) + 30 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        />
      )}
      {/* Holding-escrow yellow ring on credit node */}
      {escrowHeld !== null && id === "credit" && (
        <motion.circle
          cx={pos.x}
          cy={pos.y}
          r={(pos.r ?? 76) + 8}
          fill="none"
          stroke="#facc15"
          strokeWidth="2.5"
          strokeDasharray="4 4"
          animate={{ rotate: 360 }}
          transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
        />
      )}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r ?? 50}
        fill={`url(#grad-${id})`}
        filter="url(#node-shadow)"
        opacity={blacklisted ? 0.5 : 0.95}
      />
      {blacklisted && (
        <g>
          <line
            x1={pos.x - pos.r * 0.7}
            y1={pos.y - pos.r * 0.7}
            x2={pos.x + pos.r * 0.7}
            y2={pos.y + pos.r * 0.7}
            stroke="#ef4444"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <line
            x1={pos.x + pos.r * 0.7}
            y1={pos.y - pos.r * 0.7}
            x2={pos.x - pos.r * 0.7}
            y2={pos.y + pos.r * 0.7}
            stroke="#ef4444"
            strokeWidth="6"
            strokeLinecap="round"
          />
        </g>
      )}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r ?? 50}
        fill="none"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="1.5"
      />

      {/* Icon — lucide for user/credit, emoji fallback for borrowers/base */}
      {id === "user" ? (
        <foreignObject
          x={pos.x - 18}
          y={pos.y - 22}
          width={36}
          height={36}
          style={{ pointerEvents: "none" }}
        >
          <div style={{ display: "flex", justifyContent: "center", color: "white" }}>
            <User size={32} strokeWidth={1.8} />
          </div>
        </foreignObject>
      ) : id === "credit" ? (
        <foreignObject
          x={pos.x - 22}
          y={pos.y - 26}
          width={44}
          height={44}
          style={{ pointerEvents: "none" }}
        >
          <div style={{ display: "flex", justifyContent: "center", color: "white" }}>
            <Building2 size={36} strokeWidth={1.8} />
          </div>
        </foreignObject>
      ) : (
        <foreignObject
          x={pos.x - 16}
          y={pos.y - 20}
          width={32}
          height={32}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              color: "white",
            }}
          >
            {id === "borrower-a" ? (
              <FileText size={28} strokeWidth={1.8} />
            ) : id === "borrower-b" ? (
              <Search size={28} strokeWidth={1.8} />
            ) : (
              <LinkIcon size={20} strokeWidth={1.8} />
            )}
          </div>
        </foreignObject>
      )}

      <text
        x={pos.x}
        y={pos.y + 22}
        textAnchor="middle"
        fontSize="10"
        fontWeight="600"
        fill="white"
        opacity="0.9"
        style={{ pointerEvents: "none" }}
      >
        {meta.label.toUpperCase()}
      </text>
      <text
        x={pos.x}
        y={pos.y + pos.r + 18}
        textAnchor="middle"
        fontSize="11"
        fill="currentColor"
        opacity="0.6"
      >
        {meta.sub}
      </text>
      {balance !== undefined && (
        <motion.text
          x={pos.x}
          y={pos.y + pos.r + 34}
          textAnchor="middle"
          fontSize="13"
          fontWeight="600"
          fill="currentColor"
          opacity="0.95"
          fontFamily="ui-monospace, monospace"
          key={balance}
          initial={{ scale: 1.15, fill: "#34d399" }}
          animate={{ scale: 1, fill: "#e5e5e5" }}
          transition={{ duration: 0.4 }}
        >
          ${balance.toFixed(4)}
        </motion.text>
      )}
      {/* Escrow-held badge on credit node */}
      {escrowHeld !== null && id === "credit" && (
        <motion.g
          initial={{ opacity: 0, y: pos.y - pos.r - 22 }}
          animate={{ opacity: 1, y: pos.y - pos.r - 14 }}
          exit={{ opacity: 0 }}
        >
          <rect
            x={pos.x - 50}
            y={pos.y - pos.r - 26}
            width={100}
            height={20}
            rx={10}
            fill="#facc15"
            opacity="0.95"
          />
          <text
            x={pos.x}
            y={pos.y - pos.r - 12}
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#000"
            style={{ pointerEvents: "none" }}
          >
            🔒 HOLDING ${escrowHeld.toFixed(4)}
          </text>
        </motion.g>
      )}
      {/* Blacklisted badge */}
      {blacklisted && (
        <motion.g
          initial={{ opacity: 0, y: pos.y + pos.r + 50 }}
          animate={{ opacity: 1, y: pos.y + pos.r + 56 }}
        >
          <rect
            x={pos.x - 60}
            y={pos.y + pos.r + 44}
            width={120}
            height={20}
            rx={10}
            fill="#ef4444"
            opacity="0.95"
          />
          <text
            x={pos.x}
            y={pos.y + pos.r + 58}
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="white"
            style={{ pointerEvents: "none" }}
          >
            🚫 BLACKLISTED
          </text>
        </motion.g>
      )}
      {/* Score flash */}
      {scoreFlash && (
        <motion.text
          x={pos.x}
          y={pos.y + pos.r + 50}
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="#ef4444"
          initial={{ opacity: 1, y: pos.y + pos.r + 40 }}
          animate={{ opacity: 0, y: pos.y + pos.r + 70 }}
          transition={{ duration: 1.2 }}
        >
          score −80 ↓
        </motion.text>
      )}
      {/* Thinking dots — animated three-dot indicator under the node
          name when the agent is "working". */}
      {thinking && (
        <g style={{ pointerEvents: "none" }}>
          {[0, 1, 2].map((i) => (
            <motion.circle
              key={i}
              cx={pos.x - 12 + i * 12}
              cy={pos.y - pos.r - 12}
              r={3}
              fill="white"
              initial={{ opacity: 0.25 }}
              animate={{ opacity: [0.25, 1, 0.25] }}
              transition={{
                duration: 1.0,
                repeat: Infinity,
                delay: i * 0.18,
                ease: "easeInOut",
              }}
            />
          ))}
          <text
            x={pos.x}
            y={pos.y - pos.r - 24}
            textAnchor="middle"
            fontSize="10"
            fontWeight="600"
            fill="white"
            opacity="0.85"
          >
            working…
          </text>
        </g>
      )}
      {/* Net-earned floating notification */}
      {netEarned !== null && (
        <motion.text
          x={pos.x}
          y={pos.y - pos.r - 36}
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="#34d399"
          initial={{ opacity: 0, y: pos.y - pos.r - 24 }}
          animate={{ opacity: 1, y: pos.y - pos.r - 50 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
          style={{ pointerEvents: "none" }}
        >
          +${netEarned.toFixed(4)} net earned
        </motion.text>
      )}
      {/* Balance before → after callout */}
      {balanceDelta !== null && (
        <motion.g
          initial={{ opacity: 0, y: pos.y + pos.r + 50 }}
          animate={{ opacity: 1, y: pos.y + pos.r + 56 }}
          exit={{ opacity: 0 }}
          style={{ pointerEvents: "none" }}
        >
          <rect
            x={pos.x - 80}
            y={pos.y + pos.r + 50}
            width={160}
            height={42}
            rx={8}
            fill="rgba(20, 20, 20, 0.92)"
            stroke="#34d399"
            strokeWidth="1"
            opacity="0.95"
          />
          <text
            x={pos.x}
            y={pos.y + pos.r + 64}
            textAnchor="middle"
            fontSize="9"
            fontWeight="700"
            fill="#34d399"
            opacity="0.9"
          >
            ↑ {balanceDelta.label}
          </text>
          <text
            x={pos.x}
            y={pos.y + pos.r + 82}
            textAnchor="middle"
            fontSize="11"
            fontWeight="600"
            fill="white"
            fontFamily="ui-monospace, monospace"
          >
            ${balanceDelta.before.toFixed(4)} → ${balanceDelta.after.toFixed(4)}
          </text>
        </motion.g>
      )}
    </g>
  );
}

function CoinOrb({ transfer }: { transfer: Transfer }) {
  const from = NODE_POS[transfer.from];
  const to = NODE_POS[transfer.to];
  const cp = controlPoint(from, to);
  const pathD = `M ${from.x} ${from.y} Q ${cp.x} ${cp.y} ${to.x} ${to.y}`;
  const mid = bezier(0.5, from, cp, to);
  const style = PURPOSE_STYLE[transfer.purpose];

  return (
    <g>
      <motion.path
        d={pathD}
        stroke={style.color}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0.7 }}
        animate={{ pathLength: 1, opacity: 0.4 }}
        exit={{ opacity: 0 }}
        transition={{ duration: TRANSFER_DURATION_MS / 1000, ease: "easeOut" }}
      />
      <motion.g
        initial={{ offsetDistance: "0%", opacity: 1, scale: 0.6 }}
        animate={{ offsetDistance: "100%", opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: TRANSFER_DURATION_MS / 1000, ease: "easeOut" }}
        style={{
          offsetPath: `path("${pathD}")`,
          offsetRotate: "0deg",
        }}
      >
        <circle r={16} fill={style.color} opacity="0.35" />
        <circle r={11} fill={style.color} />
        <text
          textAnchor="middle"
          dy="4"
          fontSize="11"
          fontWeight="700"
          fill="white"
          style={{ pointerEvents: "none" }}
        >
          {style.icon}
        </text>
      </motion.g>
      <motion.text
        x={mid.x}
        y={mid.y - 22}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill={style.color}
        initial={{ opacity: 0, y: mid.y - 14 }}
        animate={{ opacity: 1, y: mid.y - 22 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.4 }}
        style={{ pointerEvents: "none" }}
      >
        {transfer.label}
      </motion.text>
    </g>
  );
}

// ───────────────────────── Transaction log ────────────────────────────

function TransactionLog({ entries }: { entries: TxLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="bg-panel-card border border-panel-border rounded-md p-6 text-center text-ink-dimmer text-sm">
        Transaction log empty — click <strong>Run Loan</strong> to start.
      </div>
    );
  }
  return (
    <div className="bg-panel-card border border-panel-border rounded-md overflow-hidden">
      <div className="px-4 py-3 border-b border-panel-border flex items-baseline justify-between">
        <h3 className="text-xs uppercase tracking-widest text-ink-dim font-mono-tight">
          Transaction log
        </h3>
        <span className="text-[11px] text-ink-dimmer font-mono-tight">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      <ul>
        <AnimatePresence initial={false}>
          {entries.map((e) => (
            <motion.li
              key={e.id}
              layout
              initial={{
                opacity: 0,
                y: -10,
                backgroundColor: "rgba(250, 204, 21, 0.15)",
              }}
              animate={{
                opacity: 1,
                y: 0,
                backgroundColor: "rgba(0, 0, 0, 0)",
              }}
              transition={{ duration: 0.6, ease: "easeOut" }}
              className="border-b border-panel-border last:border-b-0 px-4 py-3 grid grid-cols-12 gap-3 items-center text-xs font-mono-tight"
            >
              <span className="col-span-1 text-ink-dimmer">#{e.seq}</span>
              <span className="col-span-2 flex items-center gap-1.5">
                <PurposeDot purpose={e.purpose} />
                <span className="text-ink">{e.label}</span>
              </span>
              <span className="col-span-2 text-accent tabular-nums">
                {e.amount > 0 ? `$${e.amount.toFixed(4)}` : "—"}
              </span>
              <span className="col-span-2 text-ink-dim flex items-center gap-1">
                {e.fromLabel}
                <ChevronRight size={12} />
                {e.toLabel}
              </span>
              <span className="col-span-3 text-ink-dim truncate">
                {e.txHash ? (
                  <a
                    href={`https://basescan.org/tx/${e.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-info hover:underline inline-flex items-center gap-1"
                  >
                    {e.txHash.slice(0, 14)}…
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  "—"
                )}
              </span>
              <span className="col-span-1 text-ink-dimmer">
                {Math.max(0, Math.round((Date.now() - e.ts) / 1000))}s ago
              </span>
              <span className="col-span-1">
                <StatusPill status={e.status} />
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

function PurposeDot({ purpose }: { purpose: Purpose | "default" }) {
  const color =
    purpose === "default"
      ? "#ef4444"
      : PURPOSE_STYLE[purpose as Purpose].color;
  return (
    <span
      className="w-1.5 h-1.5 rounded-full inline-block"
      style={{ background: color }}
    />
  );
}

function StatusPill({
  status,
}: {
  status: "PENDING" | "CONFIRMED" | "FAILED" | "BLACKLISTED";
}) {
  const styles: Record<string, string> = {
    PENDING: "bg-warn-soft text-warn border-warn/40",
    CONFIRMED: "bg-accent-soft text-accent border-accent/40",
    FAILED: "bg-danger-soft text-danger border-danger/40",
    BLACKLISTED: "bg-danger-soft text-danger border-danger/40",
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${styles[status]}`}
    >
      {status}
    </span>
  );
}
