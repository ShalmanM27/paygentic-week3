"use client";

// Horizontal asymmetric money-flow graph.
//
//   ┌──────────────────────────────────────────────────────────┐
//   │                                                          │
//   │  USER ─────────► [ CREDIT PLATFORM ] ──────► BORROWER A  │
//   │                  (vault, big)                            │
//   │                                                          │
//   │                                          ──────► BORROWER B │
//   │                                                          │
//   ├──────────────────────────────────────────────────────────┤
//   │  BASE · USDC L2  ░ ░ ░ ░ ░ ░ ░ ░  ← block tiles         │
//   └──────────────────────────────────────────────────────────┘
//
// Driven entirely by the parent's `beatStates` array (one entry per
// beat: pending | active | confirmed | failed). The graph reacts to
// each beat transition by spawning orbs, filling/draining the vault,
// and adding block tiles to the BASE strip.

import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
} from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Briefcase,
  Building2,
  ExternalLink,
  Lock,
  User,
} from "lucide-react";
import {
  type Beat,
  type BeatStatus,
  type NodeId,
  type Purpose,
  type ScenarioKind,
  ORB_DURATION_MS,
  START_BALANCE_A,
  START_BALANCE_B,
  START_BALANCE_USER,
  mockHashFor,
} from "./flow-beats";

// ── Geometry ─────────────────────────────────────────────────────────
const SVG_W = 900;
const SVG_H = 540;
const BASE_STRIP_TOP = 470;

const NODE_POS: Record<NodeId, { x: number; y: number; r: number }> = {
  user: { x: 90, y: 240, r: 50 },
  credit: { x: 410, y: 240, r: 92 },
  // Borrowers stacked vertically on the right. Centers 250px apart
  // (≈4× radius) so the 1.4r auras don't bleed into each other and
  // there's clear breathing room between the two borrower nodes.
  "borrower-a": { x: 740, y: 120, r: 60 },
  "borrower-b": { x: 740, y: 370, r: 60 },
};

const NODE_LABEL: Record<NodeId, { name: string; sub: string }> = {
  user: { name: "USER", sub: "Pays escrow upfront" },
  credit: { name: "CREDIT PLATFORM", sub: "Escrow holder · Lender" },
  "borrower-a": { name: "BORROWER A", sub: "Summarizer agent" },
  "borrower-b": { name: "BORROWER B", sub: "Code-reviewer agent" },
};

const PURPOSE_STYLE: Record<
  Purpose,
  { from: string; to: string; glow: string; symbol: string }
> = {
  escrow: { from: "#fde68a", to: "#facc15", glow: "#facc15", symbol: "$" },
  loan: { from: "#c4b5fd", to: "#8b5cf6", glow: "#a78bfa", symbol: "$" },
  repay: { from: "#c4b5fd", to: "#8b5cf6", glow: "#a78bfa", symbol: "↩" },
  release: { from: "#86efac", to: "#22c55e", glow: "#34d399", symbol: "✓" },
  refund: { from: "#fed7aa", to: "#f97316", glow: "#fb923c", symbol: "↺" },
  fail: { from: "#fca5a5", to: "#ef4444", glow: "#ef4444", symbol: "!" },
};

// ── Curve helpers ────────────────────────────────────────────────────
function controlPoint(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  // Perpendicular offset; bias upward for visual lift.
  const offset = 60;
  return {
    x: Math.round(mx + (-dy / len) * offset),
    y: Math.round(my + (dx / len) * offset - 20),
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

// ── Local visual state types ─────────────────────────────────────────
interface ActiveOrb {
  id: string;
  beatIdx: number;
  from: NodeId;
  to: NodeId;
  purpose: Purpose;
  label: string;
  amount: number;
  fragments: boolean;
  spawnedAt: number;
}

interface BlockTile {
  id: string;
  hash: string;
  bornAt: number;
  color: string;
  height: number;
  label: string;
}

interface TxChip {
  node: NodeId;
  hash: string;
  until: number;
}

interface ParticleBurst {
  id: string;
  node: NodeId;
  color: string;
}

interface NodeShake {
  id: string;
  node: NodeId;
}

// ── Public API ──────────────────────────────────────────────────────
export type NodeBadge =
  | { type: "blacklisted" }
  | { type: "holding"; amount: number };

export interface MoneyFlowGraphProps {
  scenario: ScenarioKind | null;
  beats: Beat[];
  beatStates: BeatStatus[];
  /** Reset signal — when this changes, all visual state clears. */
  runId: number;
}

export function MoneyFlowGraph({
  scenario,
  beats,
  beatStates,
  runId,
}: MoneyFlowGraphProps) {
  const [mounted, setMounted] = useState(false);
  const [orbs, setOrbs] = useState<ActiveOrb[]>([]);
  const [vault, setVault] = useState<{ holding: boolean; amount: number }>({
    holding: false,
    amount: 0,
  });
  const [processing, setProcessing] = useState<NodeId | null>(null);
  const [blacklisted, setBlacklisted] = useState<Set<NodeId>>(new Set());
  const [bursts, setBursts] = useState<ParticleBurst[]>([]);
  const [shakeNode, setShakeNode] = useState<NodeId | null>(null);
  const [blockTiles, setBlockTiles] = useState<BlockTile[]>([]);
  const [txChips, setTxChips] = useState<Record<string, TxChip | null>>({});
  const [balances, setBalances] = useState<Record<NodeId, number>>({
    user: START_BALANCE_USER,
    credit: 0,
    "borrower-a": START_BALANCE_A,
    "borrower-b": START_BALANCE_B,
  });

  const startedRef = useRef<Set<number>>(new Set());
  const confirmedRef = useRef<Set<number>>(new Set());
  const orbSeqRef = useRef(0);
  const burstSeqRef = useRef(0);
  const tileSeqRef = useRef(0);
  const blockHeightRef = useRef(18_472_300);

  useEffect(() => setMounted(true), []);

  // Hard reset on runId change.
  useEffect(() => {
    startedRef.current = new Set();
    confirmedRef.current = new Set();
    setOrbs([]);
    setVault({ holding: false, amount: 0 });
    setProcessing(null);
    setBlacklisted(new Set());
    setBursts([]);
    setShakeNode(null);
    setBlockTiles([]);
    setTxChips({});
    setBalances({
      user: START_BALANCE_USER,
      credit: 0,
      "borrower-a": START_BALANCE_A,
      "borrower-b": START_BALANCE_B,
    });
  }, [runId]);

  // React to beat transitions (parent advances beatStates[]).
  useEffect(() => {
    if (!scenario) return;
    beats.forEach((beat, idx) => {
      const status = beatStates[idx];
      // ACTIVE → fire orb + start side effects.
      if (
        (status === "active" || status === "confirmed" || status === "failed") &&
        !startedRef.current.has(idx)
      ) {
        startedRef.current.add(idx);
        if (beat.orb) {
          orbSeqRef.current += 1;
          const id = `orb-${runId}-${idx}-${orbSeqRef.current}`;
          setOrbs((prev) => [
            ...prev,
            {
              id,
              beatIdx: idx,
              from: beat.orb!.from,
              to: beat.orb!.to,
              purpose: beat.orb!.purpose,
              label: beat.orb!.label,
              amount: beat.orb!.amount,
              fragments: !!beat.orb!.fragments,
              spawnedAt: Date.now(),
            },
          ]);
        }
        if (beat.effect === "processing_a") setProcessing("borrower-a");
        else if (beat.effect === "processing_b") setProcessing("borrower-b");
        else if (beat.effect === "stop_processing") setProcessing(null);
        // When the failure orb starts, schedule a shake on the source
        // borrower at ~60% of the flight (when fragmentation hits).
        if (beat.orb?.fragments) {
          const src = beat.orb.from;
          const at = ORB_DURATION_MS * 0.6;
          setTimeout(() => {
            setShakeNode(src);
            setTimeout(() => setShakeNode(null), 400);
          }, at);
        }
        // Graph-only secondary orb (e.g. the loan disbursement during
        // the "Borrower does the work" beat). Fires after the
        // configured delay; the checklist ignores it.
        if (beat.extraOrb) {
          const xb = beat.extraOrb;
          const delay = beat.extraOrbDelayMs ?? 0;
          setTimeout(() => {
            orbSeqRef.current += 1;
            const id = `xorb-${runId}-${idx}-${orbSeqRef.current}`;
            setOrbs((prev) => [
              ...prev,
              {
                id,
                beatIdx: idx,
                from: xb.from,
                to: xb.to,
                purpose: xb.purpose,
                label: xb.label,
                amount: xb.amount,
                fragments: !!xb.fragments,
                spawnedAt: Date.now(),
              },
            ]);
            // Burst + tx chip + block tile when it lands.
            const dest = xb.to;
            const color = PURPOSE_STYLE[xb.purpose].glow;
            setTimeout(() => {
              burstSeqRef.current += 1;
              const burstId = `xb-${runId}-${idx}-${burstSeqRef.current}`;
              setBursts((prev) => [...prev, { id: burstId, node: dest, color }]);
              setTimeout(() => {
                setBursts((prev) => prev.filter((b) => b.id !== burstId));
              }, 800);
              const hash = mockHashFor(`x-${runId}-${idx}-${xb.label}`);
              setTxChips((prev) => ({
                ...prev,
                [dest]: { node: dest, hash, until: Date.now() + 8000 },
              }));
              tileSeqRef.current += 1;
              blockHeightRef.current += 1;
              const tileId = `xt-${runId}-${idx}-${tileSeqRef.current}`;
              setBlockTiles((prev) => {
                const next = [
                  ...prev,
                  {
                    id: tileId,
                    hash,
                    bornAt: Date.now(),
                    color,
                    height: blockHeightRef.current,
                    label: `$${xb.amount.toFixed(4)}`,
                  },
                ];
                return next.slice(-9);
              });
            }, ORB_DURATION_MS);
          }, delay);
        }
      }
      // CONFIRMED / FAILED → land effect: vault, balances, block tile.
      if (
        (status === "confirmed" || status === "failed") &&
        !confirmedRef.current.has(idx)
      ) {
        confirmedRef.current.add(idx);
        // Vault state changes
        if (beat.effect === "vault_fill") {
          setVault({ holding: true, amount: 0.008 });
        } else if (
          beat.effect === "vault_drain_to_borrower" ||
          beat.effect === "vault_drain_to_user"
        ) {
          setVault({ holding: false, amount: 0 });
        }
        if (beat.effect === "blacklist_b") {
          setBlacklisted((prev) => {
            const next = new Set(prev);
            next.add("borrower-b");
            return next;
          });
        }

        // Balance updates
        const nextBalances = { ...balances };
        let balanceChanged = false;
        if (beat.balanceA !== undefined) {
          nextBalances["borrower-a"] = beat.balanceA;
          balanceChanged = true;
        }
        if (beat.balanceB !== undefined) {
          nextBalances["borrower-b"] = beat.balanceB;
          balanceChanged = true;
        }
        if (beat.balanceUser !== undefined) {
          nextBalances.user = beat.balanceUser;
          balanceChanged = true;
        }
        if (balanceChanged) setBalances(nextBalances);

        // Particle burst at orb destination + tx chip (only on
        // successful orb landings — failures already render their own
        // fragmentation visual).
        if (beat.orb && status !== "failed") {
          const dest = beat.orb.to;
          const color = PURPOSE_STYLE[beat.orb.purpose].glow;
          burstSeqRef.current += 1;
          const burstId = `burst-${runId}-${idx}-${burstSeqRef.current}`;
          setBursts((prev) => [...prev, { id: burstId, node: dest, color }]);
          setTimeout(() => {
            setBursts((prev) => prev.filter((b) => b.id !== burstId));
          }, 800);

          const hash = mockHashFor(`${runId}-${idx}-${beat.orb.label}`);
          setTxChips((prev) => ({
            ...prev,
            [dest]: { node: dest, hash, until: Date.now() + 8000 },
          }));
        }

        // EVERY settled beat (success OR fail, orb OR not) lands a
        // block on Base. That's what makes the strip feel live.
        const tileColor = beat.orb
          ? PURPOSE_STYLE[beat.orb.purpose].glow
          : status === "failed"
            ? "#ef4444"
            : "#60a5fa";
        const tileLabel = beat.orb
          ? `$${beat.orb.amount.toFixed(4)}`
          : beat.effect === "vault_fill"
            ? "LOCK"
            : beat.effect === "blacklist_b"
              ? "BLOCK"
              : beat.effect === "processing_a" ||
                  beat.effect === "processing_b"
                ? "JOB"
                : "EVT";
        const tileHash = mockHashFor(
          `${runId}-${idx}-${beat.step}-${status}`,
        );
        tileSeqRef.current += 1;
        blockHeightRef.current += 1;
        const tileId = `tile-${runId}-${idx}-${tileSeqRef.current}`;
        const tileHeight = blockHeightRef.current;
        setBlockTiles((prev) => {
          const next = [
            ...prev,
            {
              id: tileId,
              hash: tileHash,
              bornAt: Date.now(),
              color: tileColor,
              height: tileHeight,
              label: tileLabel,
            },
          ];
          return next.slice(-9);
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatStates, beats, scenario, runId]);

  // GC orbs when their flight time elapses (they self-remove via
  // AnimatePresence exit, but we also clean state).
  useEffect(() => {
    if (orbs.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setOrbs((prev) =>
        prev.filter((o) => now - o.spawnedAt < ORB_DURATION_MS + 400),
      );
    }, 300);
    return () => clearInterval(t);
  }, [orbs.length]);

  // GC tx chips after their `until`.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTxChips((prev) => {
        const next: Record<string, TxChip | null> = {};
        let changed = false;
        for (const k of Object.keys(prev)) {
          const v = prev[k];
          if (v && v.until > now) {
            next[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 700);
    return () => clearInterval(t);
  }, []);

  // Block tiles persist for the entire run (no GC). They reset when
  // the parent bumps runId. Keeping them visible the whole time means
  // the BASE strip looks like a real, accumulating ledger.

  const heldEscrow = vault.holding ? vault.amount : 0;

  if (!mounted) {
    return (
      <div className="w-full bg-panel-card border border-panel-border rounded-md p-12 text-center text-ink-dimmer text-sm">
        Loading network…
      </div>
    );
  }

  return (
    <div className="relative w-full bg-panel-card border border-panel-border rounded-md overflow-hidden">
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="w-full h-auto"
        style={{ maxHeight: 640, minHeight: 420 }}
      >
        <defs>
          {(Object.keys(PURPOSE_STYLE) as Purpose[]).map((p) => (
            <linearGradient
              key={p}
              id={`grad-${p}`}
              x1="0"
              y1="0"
              x2="1"
              y2="0"
            >
              <stop offset="0%" stopColor={PURPOSE_STYLE[p].from} />
              <stop offset="100%" stopColor={PURPOSE_STYLE[p].to} />
            </linearGradient>
          ))}
          <radialGradient id="node-user" cx="0.3" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#3b82f6" />
          </radialGradient>
          <radialGradient id="node-credit" cx="0.3" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#a5b4fc" />
            <stop offset="100%" stopColor="#6366f1" />
          </radialGradient>
          <radialGradient id="node-a" cx="0.3" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#86efac" />
            <stop offset="100%" stopColor="#10b981" />
          </radialGradient>
          <radialGradient id="node-b" cx="0.3" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#fcd34d" />
            <stop offset="100%" stopColor="#d97706" />
          </radialGradient>
          <radialGradient id="node-b-dead" cx="0.3" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#7f1d1d" />
            <stop offset="100%" stopColor="#3f1010" />
          </radialGradient>
          <pattern
            id="strip-grid"
            x="0"
            y="0"
            width="20"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="40"
              stroke="rgba(255,255,255,0.04)"
            />
          </pattern>
          <filter
            id="orb-label-shadow"
            x="-30%"
            y="-30%"
            width="160%"
            height="160%"
          >
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
            <feOffset dx="0" dy="2" result="offsetblur" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.6" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* BASE strip — substrate showing block-by-block confirmations */}
        <rect
          x="0"
          y={BASE_STRIP_TOP}
          width={SVG_W}
          height={SVG_H - BASE_STRIP_TOP}
          fill="#020617"
        />
        <rect
          x="0"
          y={BASE_STRIP_TOP}
          width={SVG_W}
          height={SVG_H - BASE_STRIP_TOP}
          fill="url(#strip-grid)"
        />
        {/* Top divider line with subtle pulse */}
        <motion.line
          x1="0"
          y1={BASE_STRIP_TOP}
          x2={SVG_W}
          y2={BASE_STRIP_TOP}
          stroke="#1e3a8a"
          strokeWidth="1"
          animate={{ opacity: [0.4, 0.8, 0.4] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        />
        {/* Live pulse dot */}
        <motion.circle
          cx={20}
          cy={BASE_STRIP_TOP + 18}
          r={4}
          fill="#22c55e"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
        <text
          x="32"
          y={BASE_STRIP_TOP + 22}
          fontSize="11"
          fill="#60a5fa"
          fontFamily="ui-monospace, monospace"
          fontWeight="800"
          letterSpacing="1.5"
        >
          BASE · USDC L2
        </text>
        <text
          x="32"
          y={BASE_STRIP_TOP + 38}
          fontSize="9"
          fill="#475569"
          fontFamily="ui-monospace, monospace"
          letterSpacing="0.5"
        >
          {blockTiles.length === 0
            ? "live · waiting for first block"
            : `${blockTiles.length} block${
                blockTiles.length === 1 ? "" : "s"
              } · click a tile to verify on BaseScan`}
        </text>
        {/* Block height indicator on the right */}
        {blockTiles.length > 0 && (
          <g>
            <text
              x={SVG_W - 14}
              y={BASE_STRIP_TOP + 22}
              textAnchor="end"
              fontSize="9"
              fill="#64748b"
              fontFamily="ui-monospace, monospace"
              letterSpacing="1"
            >
              BLOCK HEIGHT
            </text>
            <motion.text
              key={blockTiles[blockTiles.length - 1]!.height}
              x={SVG_W - 14}
              y={BASE_STRIP_TOP + 38}
              textAnchor="end"
              fontSize="13"
              fontWeight="800"
              fill="#22c55e"
              fontFamily="ui-monospace, monospace"
              initial={{ opacity: 0.4, scale: 1.15 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 }}
            >
              #{blockTiles[blockTiles.length - 1]!.height.toLocaleString()}
            </motion.text>
          </g>
        )}
        <BlockTilesStrip tiles={blockTiles} />

        {/* Edges (only visible when an orb is in flight on them) */}
        <Edges orbs={orbs} />

        {/* Active orbs */}
        <AnimatePresence>
          {orbs.map((orb) => (
            <CoinOrb key={orb.id} orb={orb} />
          ))}
        </AnimatePresence>

        {/* Particle bursts */}
        <AnimatePresence>
          {bursts.map((b) => (
            <ParticleBurstFx key={b.id} burst={b} />
          ))}
        </AnimatePresence>

        {/* Nodes — z-order: user, A, B, credit (so vault is on top) */}
        <NodeRender
          id="user"
          balance={balances.user}
          burst={!!bursts.find((b) => b.node === "user")}
        />
        <NodeRender
          id="borrower-a"
          balance={balances["borrower-a"]}
          processing={processing === "borrower-a"}
          burst={!!bursts.find((b) => b.node === "borrower-a")}
        />
        <NodeRender
          id="borrower-b"
          balance={balances["borrower-b"]}
          processing={processing === "borrower-b"}
          blacklisted={blacklisted.has("borrower-b")}
          burst={!!bursts.find((b) => b.node === "borrower-b")}
          shake={shakeNode === "borrower-b"}
        />
        <NodeRender
          id="credit"
          balance={balances.credit}
          escrowHeld={heldEscrow}
          burst={!!bursts.find((b) => b.node === "credit")}
        />

        {/* Tx hash chips below node */}
        <AnimatePresence>
          {Object.values(txChips).map((chip) => {
            if (!chip) return null;
            const pos = NODE_POS[chip.node as NodeId];
            if (!pos) return null;
            return (
              <motion.g
                key={`${chip.node}-${chip.hash}`}
                initial={{ opacity: 0, y: pos.y + pos.r + 16 }}
                animate={{ opacity: 1, y: pos.y + pos.r + 26 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
              >
                <foreignObject
                  x={pos.x - 80}
                  y={pos.y + pos.r + 22}
                  width={160}
                  height={24}
                >
                  <a
                    href={`https://basescan.org/tx/${chip.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      background: "rgba(15,23,42,0.95)",
                      border: "1px solid rgba(96,165,250,0.4)",
                      borderRadius: 6,
                      padding: "2px 7px",
                      fontSize: 10,
                      fontFamily: "ui-monospace, monospace",
                      color: "#60a5fa",
                      textDecoration: "none",
                    }}
                  >
                    {chip.hash.slice(0, 10)}…{chip.hash.slice(-4)}
                    <span style={{ opacity: 0.6 }}>↗</span>
                  </a>
                </foreignObject>
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>
    </div>
  );
}

// ── Edges ────────────────────────────────────────────────────────────
function Edges({ orbs }: { orbs: ActiveOrb[] }) {
  const active = useMemo(() => {
    const m = new Map<string, ActiveOrb>();
    for (const o of orbs) m.set(`${o.from}->${o.to}`, o);
    return m;
  }, [orbs]);
  const pairs: Array<[NodeId, NodeId]> = [
    ["user", "credit"],
    ["credit", "user"],
    ["credit", "borrower-a"],
    ["borrower-a", "credit"],
    ["credit", "borrower-b"],
    ["borrower-b", "credit"],
  ];
  return (
    <g>
      {pairs.map(([a, b]) => {
        const orb = active.get(`${a}->${b}`);
        if (!orb) return null;
        const p0 = NODE_POS[a];
        const p2 = NODE_POS[b];
        const cp = controlPoint(p0, p2);
        const d = `M ${p0.x} ${p0.y} Q ${cp.x} ${cp.y} ${p2.x} ${p2.y}`;
        return (
          <motion.path
            key={`${a}-${b}`}
            d={d}
            stroke={`url(#grad-${orb.purpose})`}
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeDasharray="6 8"
            initial={{ opacity: 0, strokeDashoffset: 0 }}
            animate={{ opacity: 0.85, strokeDashoffset: -120 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: 0.25 },
              strokeDashoffset: {
                duration: 1.4,
                repeat: Infinity,
                ease: "linear",
              },
            }}
          />
        );
      })}
    </g>
  );
}

// ── Coin orb (spring physics + trail + fragmentation) ────────────────
function CoinOrb({ orb }: { orb: ActiveOrb }) {
  const from = NODE_POS[orb.from];
  const to = NODE_POS[orb.to];
  const cp = controlPoint(from, to);
  const pathD = `M ${from.x} ${from.y} Q ${cp.x} ${cp.y} ${to.x} ${to.y}`;
  const mid = bezier(0.5, from, cp, to);
  const style = PURPOSE_STYLE[orb.purpose];

  // Fragmentation: orb travels to ~60% then bursts apart.
  if (orb.fragments) {
    const breakAt = bezier(0.6, from, cp, to);
    return (
      <g>
        <motion.g
          initial={{ offsetDistance: "0%", opacity: 1, scale: 1 }}
          animate={{ offsetDistance: "60%", opacity: 1, scale: 1 }}
          transition={{
            type: "spring",
            stiffness: 60,
            damping: 14,
            mass: 0.8,
            duration: ORB_DURATION_MS / 1000,
          }}
          style={{ offsetPath: `path("${pathD}")`, offsetRotate: "0deg" }}
        >
          <circle r={18} fill={style.glow} opacity="0.35" />
          <circle r={11} fill={`url(#grad-${orb.purpose})`} />
          <text
            textAnchor="middle"
            dy="4"
            fontSize="11"
            fontWeight="800"
            fill="white"
            style={{ pointerEvents: "none" }}
          >
            !
          </text>
        </motion.g>
        {/* Fragments scatter from breakAt */}
        {[0, 1, 2, 3].map((i) => {
          const angle = (i * Math.PI) / 2 + 0.4;
          const dist = 50;
          return (
            <motion.circle
              key={i}
              r={5}
              fill={style.glow}
              cx={breakAt.x}
              cy={breakAt.y}
              initial={{
                cx: breakAt.x,
                cy: breakAt.y,
                opacity: 0,
              }}
              animate={{
                cx: breakAt.x + Math.cos(angle) * dist,
                cy: breakAt.y + Math.sin(angle) * dist,
                opacity: [0, 0, 1, 0],
              }}
              transition={{
                duration: 1.2,
                times: [0, 0.6, 0.7, 1],
                ease: "easeOut",
              }}
            />
          );
        })}
        {/* Red X at breakage point */}
        <motion.g
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0, 1, 1, 0] }}
          transition={{ duration: 1.2, times: [0, 0.6, 0.7, 0.95, 1] }}
        >
          <line
            x1={breakAt.x - 7}
            y1={breakAt.y - 7}
            x2={breakAt.x + 7}
            y2={breakAt.y + 7}
            stroke="#ef4444"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <line
            x1={breakAt.x + 7}
            y1={breakAt.y - 7}
            x2={breakAt.x - 7}
            y2={breakAt.y + 7}
            stroke="#ef4444"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </motion.g>
        <motion.g
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{
            duration: ORB_DURATION_MS / 1000,
            times: [0, 0.2, 0.85, 1],
          }}
          style={{ pointerEvents: "none" }}
        >
          <rect
            x={mid.x - 90}
            y={mid.y - 60}
            width={180}
            height={32}
            rx={16}
            fill="rgba(60,8,8,0.95)"
            stroke="#ef4444"
            strokeWidth="2"
            filter="url(#orb-label-shadow)"
          />
          <text
            x={mid.x}
            y={mid.y - 39}
            textAnchor="middle"
            fontSize="15"
            fontWeight="800"
            fill="#fca5a5"
            fontFamily="ui-monospace, monospace"
            letterSpacing="0.5"
          >
            {orb.label} · FAILED
          </text>
        </motion.g>
      </g>
    );
  }

  return (
    <g>
      {/* Trail — six fading copies along the path with offset start. */}
      {[0.06, 0.1, 0.14, 0.18, 0.22, 0.26].map((delay, i) => (
        <motion.circle
          key={i}
          r={9 - i}
          fill={style.glow}
          opacity={0.45 - i * 0.06}
          initial={{ offsetDistance: "0%" }}
          animate={{ offsetDistance: "100%" }}
          transition={{
            type: "spring",
            stiffness: 60,
            damping: 14,
            mass: 0.8,
            duration: ORB_DURATION_MS / 1000,
            delay,
          }}
          style={{ offsetPath: `path("${pathD}")`, offsetRotate: "0deg" }}
        />
      ))}
      <motion.g
        initial={{ offsetDistance: "0%", opacity: 1, scale: 0.7 }}
        animate={{ offsetDistance: "100%", opacity: 1, scale: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{
          type: "spring",
          stiffness: 60,
          damping: 14,
          mass: 0.8,
          duration: ORB_DURATION_MS / 1000,
        }}
        style={{ offsetPath: `path("${pathD}")`, offsetRotate: "0deg" }}
      >
        <circle r={18} fill={style.glow} opacity="0.4" />
        <circle r={12} fill={`url(#grad-${orb.purpose})`} />
        {/* upper-left highlight */}
        <circle cx={-3} cy={-3} r={3.5} fill="white" opacity="0.5" />
        <text
          textAnchor="middle"
          dy="4"
          fontSize="11"
          fontWeight="800"
          fill="white"
          style={{ pointerEvents: "none" }}
        >
          {style.symbol}
        </text>
      </motion.g>
      {/* Floating label — large, glowing pill that follows the orb's
       *  midpoint. Fades in fast, holds, then fades out late so the
       *  amount is readable for the entire flight. */}
      <motion.g
        initial={{ opacity: 0, y: mid.y - 14 }}
        animate={{ opacity: [0, 1, 1, 1, 0.9], y: mid.y - 38 }}
        exit={{ opacity: 0 }}
        transition={{
          duration: ORB_DURATION_MS / 1000,
          times: [0, 0.15, 0.5, 0.85, 1],
        }}
        style={{ pointerEvents: "none" }}
      >
        <rect
          x={mid.x - 80}
          y={mid.y - 60}
          width={160}
          height={32}
          rx={16}
          fill="rgba(7,11,22,0.95)"
          stroke={style.glow}
          strokeWidth="2"
          filter="url(#orb-label-shadow)"
        />
        <text
          x={mid.x}
          y={mid.y - 39}
          textAnchor="middle"
          fontSize="16"
          fontWeight="800"
          fill="white"
          fontFamily="ui-monospace, monospace"
          letterSpacing="0.5"
        >
          {orb.label}
        </text>
      </motion.g>
    </g>
  );
}

// ── Node renderer (3 layers: aura, ring, core + icon + balance) ──────
function NodeRender({
  id,
  balance,
  processing = false,
  blacklisted = false,
  escrowHeld = 0,
  burst = false,
  shake = false,
}: {
  id: NodeId;
  balance: number;
  processing?: boolean;
  blacklisted?: boolean;
  escrowHeld?: number;
  burst?: boolean;
  shake?: boolean;
}) {
  const pos = NODE_POS[id];
  const label = NODE_LABEL[id];
  const isCredit = id === "credit";
  const fillId =
    id === "user"
      ? "node-user"
      : id === "credit"
        ? "node-credit"
        : id === "borrower-a"
          ? "node-a"
          : blacklisted
            ? "node-b-dead"
            : "node-b";

  // Aura behaviour per node. Blacklisted nodes get an irregular
  // flicker (5 randomised opacity stops over 1.2s) instead of the
  // steady breath. Healthy nodes pulse at scenario-appropriate rates.
  const auraDuration = blacklisted
    ? 1.2
    : isCredit
      ? 4
      : id === "user"
        ? 3
        : processing
          ? 2
          : 4;
  const auraColor = blacklisted
    ? "#ef4444"
    : id === "user"
      ? "#3b82f6"
      : isCredit
        ? "#6366f1"
        : id === "borrower-a"
          ? "#10b981"
          : "#d97706";

  return (
    <motion.g
      animate={
        shake ? { x: [0, -5, 6, -4, 4, -2, 0] } : { x: 0 }
      }
      transition={
        shake ? { duration: 0.42, ease: "easeInOut" } : { duration: 0.2 }
      }
    >
      {/* Outer aura — blurred halo. Behaviour switches on blacklist
          state: smooth pulse → flicker. Color crossfades over 800ms
          via Framer's `animate` on `fill` (color tween). */}
      <motion.circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r * 1.4}
        animate={
          blacklisted
            ? {
                fill: "#ef4444",
                opacity: [0.18, 0.5, 0.22, 0.55, 0.25, 0.45, 0.2],
                scale: [1, 1.04, 1, 1.06, 1, 1.04, 1],
              }
            : {
                fill: auraColor,
                opacity: [0.18, 0.32, 0.18],
                scale: [1, 1.07, 1],
              }
        }
        transition={{
          duration: auraDuration,
          repeat: Infinity,
          ease: blacklisted ? "linear" : "easeInOut",
        }}
        style={{
          transformOrigin: `${pos.x}px ${pos.y}px`,
          filter: "blur(18px)",
          willChange: "transform, opacity",
        }}
      />
      {/* Burst pulse on arrival */}
      {burst && (
        <motion.circle
          cx={pos.x}
          cy={pos.y}
          r={pos.r}
          fill="none"
          stroke={auraColor}
          strokeWidth="3"
          initial={{ opacity: 0.85, r: pos.r }}
          animate={{ opacity: 0, r: pos.r + 30 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      )}
      {/* Credit-only rotating dashed ring */}
      {isCredit && (
        <motion.circle
          cx={pos.x}
          cy={pos.y}
          r={pos.r + 14}
          fill="none"
          stroke="#facc15"
          strokeWidth="2"
          strokeDasharray="3 6"
          opacity={escrowHeld > 0 ? 0.85 : 0.25}
          animate={{ rotate: 360 }}
          transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
        />
      )}
      {/* Inner ring */}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r * 1.05}
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="2"
      />
      {/* Core */}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r}
        fill={`url(#${fillId})`}
        opacity={blacklisted ? 0.7 : 1}
      />
      {/* Vault liquid coins inside CREDIT node */}
      {isCredit && (
        <VaultCoins held={escrowHeld > 0} cx={pos.x} cy={pos.y} r={pos.r} />
      )}
      {/* Icon */}
      <foreignObject
        x={pos.x - 22}
        y={pos.y - 24}
        width={44}
        height={44}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            color: "white",
            opacity: blacklisted ? 0.5 : 1,
          }}
        >
          {id === "user" ? (
            <User size={32} strokeWidth={1.7} />
          ) : id === "credit" ? (
            <div style={{ position: "relative" }}>
              <Building2 size={36} strokeWidth={1.7} />
              <div
                style={{
                  position: "absolute",
                  bottom: -2,
                  right: -6,
                  background: "#facc15",
                  borderRadius: 4,
                  padding: 1,
                  display: "flex",
                }}
              >
                <Lock size={10} strokeWidth={2} color="#000" />
              </div>
            </div>
          ) : (
            <div style={{ position: "relative" }}>
              <Briefcase size={28} strokeWidth={1.7} />
              <span
                style={{
                  position: "absolute",
                  bottom: -4,
                  right: -8,
                  background: "rgba(255,255,255,0.95)",
                  color: "#000",
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  fontSize: 9,
                  fontWeight: 800,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {id === "borrower-a" ? "A" : "B"}
              </span>
            </div>
          )}
        </div>
      </foreignObject>

      {/* Processing dots above node */}
      {processing && (
        <g style={{ pointerEvents: "none" }}>
          <text
            x={pos.x}
            y={pos.y - pos.r - 24}
            textAnchor="middle"
            fontSize="10"
            fontWeight="600"
            fill="white"
            opacity="0.85"
          >
            processing…
          </text>
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
                duration: 1,
                repeat: Infinity,
                delay: i * 0.2,
                ease: "easeInOut",
              }}
            />
          ))}
        </g>
      )}

      {/* Blacklist badge — slides in from top-right with a tilted-in
          spring that overshoots and settles. Persists for the rest of
          the run. */}
      {blacklisted && (
        <motion.g
          initial={{ scale: 0, rotate: -45, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 220,
            damping: 12,
            mass: 0.8,
          }}
          style={{
            transformOrigin: `${pos.x + pos.r * 0.7}px ${pos.y - pos.r * 0.7}px`,
          }}
        >
          <circle
            cx={pos.x + pos.r * 0.7}
            cy={pos.y - pos.r * 0.7}
            r={15}
            fill="#ef4444"
            stroke="#0f172a"
            strokeWidth="2.5"
          />
          <motion.circle
            cx={pos.x + pos.r * 0.7}
            cy={pos.y - pos.r * 0.7}
            r={15}
            fill="none"
            stroke="#fca5a5"
            strokeWidth="2"
            animate={{ scale: [1, 1.4, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            style={{
              transformOrigin: `${pos.x + pos.r * 0.7}px ${pos.y - pos.r * 0.7}px`,
            }}
          />
          <text
            x={pos.x + pos.r * 0.7}
            y={pos.y - pos.r * 0.7 + 5}
            textAnchor="middle"
            fontSize="15"
            fontWeight="800"
            fill="white"
          >
            ✕
          </text>
        </motion.g>
      )}

      {/* Name + sub */}
      <text
        x={pos.x}
        y={pos.y + 24}
        textAnchor="middle"
        fontSize="9"
        fontWeight="800"
        letterSpacing="1.2"
        fill="white"
        opacity={blacklisted ? 0.5 : 0.95}
        style={{ pointerEvents: "none" }}
      >
        {label.name}
      </text>
      <text
        x={pos.x}
        y={pos.y + pos.r + 14}
        textAnchor="middle"
        fontSize="10"
        fill="white"
        opacity="0.6"
      >
        {label.sub}
      </text>
      {/* Animated balance */}
      <BalanceText
        cx={pos.x}
        cy={pos.y + pos.r + 30}
        balance={balance}
        flagged={blacklisted}
      />
    </motion.g>
  );
}

function BalanceText({
  cx,
  cy,
  balance,
  flagged,
}: {
  cx: number;
  cy: number;
  balance: number;
  flagged: boolean;
}) {
  // Real numeric count-up from previous → next value over 600ms.
  // useMotionValue + animate() drives a derived string that updates
  // every frame. Color flashes green-up / red-down briefly on change.
  const motionVal = useMotionValue(balance);
  const display = useTransform(motionVal, (v) => `$${v.toFixed(4)}`);
  const prevRef = useRef(balance);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev === balance) return;
    setFlash(balance > prev ? "up" : "down");
    const controls = animate(motionVal, balance, {
      duration: 0.6,
      ease: "easeOut",
    });
    const t = setTimeout(() => setFlash(null), 700);
    prevRef.current = balance;
    return () => {
      controls.stop();
      clearTimeout(t);
    };
  }, [balance, motionVal]);

  const fillColor = flagged
    ? "#ef4444"
    : flash === "up"
      ? "#34d399"
      : flash === "down"
        ? "#fb923c"
        : "#86efac";

  return (
    <motion.text
      x={cx}
      y={cy}
      textAnchor="middle"
      fontSize="13"
      fontWeight="700"
      fill={fillColor}
      fontFamily="ui-monospace, monospace"
      animate={{ scale: flash ? [1, 1.25, 1] : 1 }}
      transition={{ duration: 0.4 }}
    >
      <motion.tspan>{display}</motion.tspan>
    </motion.text>
  );
}

// Vault coins inside credit node — fills like liquid in a jar.
function VaultCoins({
  held,
  cx,
  cy,
  r,
}: {
  held: boolean;
  cx: number;
  cy: number;
  r: number;
}) {
  // 8 coin dots stacked at the bottom of the circle.
  const coinR = 4;
  const coins: Array<{ x: number; y: number }> = [];
  // pack a 4x2 grid of coins inside the lower half.
  const cols = 4;
  const rows = 2;
  const spacing = coinR * 2.4;
  const startX = cx - ((cols - 1) * spacing) / 2;
  const startY = cy + r * 0.55;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      coins.push({
        x: startX + col * spacing,
        y: startY - row * spacing,
      });
    }
  }
  return (
    <AnimatePresence>
      {held &&
        coins.map((c, i) => (
          <motion.circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={coinR}
            fill="#facc15"
            stroke="#fbbf24"
            strokeWidth="0.6"
            initial={{ opacity: 0, cy: c.y + 18 }}
            animate={{ opacity: 1, cy: c.y }}
            exit={{ opacity: 0, cy: c.y + 24 }}
            transition={{ duration: 0.4, delay: i * 0.04 }}
          />
        ))}
    </AnimatePresence>
  );
}

// Particle burst — 8 dots flying out from a node.
function ParticleBurstFx({ burst }: { burst: ParticleBurst }) {
  const pos = NODE_POS[burst.node];
  if (!pos) return null;
  return (
    <g style={{ pointerEvents: "none" }}>
      {Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        const dist = 30 + Math.random() * 12;
        return (
          <motion.circle
            key={i}
            r={3}
            fill={burst.color}
            cx={pos.x}
            cy={pos.y}
            initial={{ cx: pos.x, cy: pos.y, opacity: 1 }}
            animate={{
              cx: pos.x + Math.cos(angle) * dist,
              cy: pos.y + Math.sin(angle) * dist,
              opacity: 0,
            }}
            transition={{ duration: 0.7, ease: "easeOut" }}
          />
        );
      })}
    </g>
  );
}

// BASE strip block tiles — slide in from right, drift left, fade out.
// Each tile is a sized "block" showing label (amount or event), short
// hash, and a glowing border in the transaction's color.
function BlockTilesStrip({ tiles }: { tiles: BlockTile[] }) {
  const tileW = 60;
  const tileGap = 6;
  const trackRight = SVG_W - 200; // leave room for block-height label
  return (
    <g>
      <AnimatePresence>
        {tiles.map((t, i) => {
          const fromRight = tiles.length - 1 - i;
          const x = trackRight - fromRight * (tileW + tileGap);
          return (
            <motion.g
              key={t.id}
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{
                type: "spring",
                stiffness: 180,
                damping: 22,
                duration: 0.6,
              }}
            >
              <a
                href={`https://basescan.org/tx/${t.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                <rect
                  x={x - tileW + 2}
                  y={BASE_STRIP_TOP + 46}
                  width={tileW - 4}
                  height={48}
                  rx={6}
                  fill="rgba(7,11,22,0.95)"
                  stroke={t.color}
                  strokeWidth="1.6"
                  style={{ cursor: "pointer" }}
                />
                <text
                  x={x - tileW / 2}
                  y={BASE_STRIP_TOP + 60}
                  textAnchor="middle"
                  fontSize="8"
                  fontWeight="700"
                  fill={t.color}
                  fontFamily="ui-monospace, monospace"
                  letterSpacing="0.6"
                  style={{ pointerEvents: "none" }}
                >
                  #{t.height.toString().slice(-5)}
                </text>
                <text
                  x={x - tileW / 2}
                  y={BASE_STRIP_TOP + 76}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="800"
                  fill="white"
                  fontFamily="ui-monospace, monospace"
                  style={{ pointerEvents: "none" }}
                >
                  {t.label}
                </text>
                <text
                  x={x - tileW / 2}
                  y={BASE_STRIP_TOP + 89}
                  textAnchor="middle"
                  fontSize="7"
                  fill="#64748b"
                  fontFamily="ui-monospace, monospace"
                  style={{ pointerEvents: "none" }}
                >
                  {t.hash.slice(2, 8)}
                </text>
              </a>
            </motion.g>
          );
        })}
      </AnimatePresence>
    </g>
  );
}

// Re-export an external hint used by page (currently unused but kept
// for backwards compat with existing imports).
export const FLOW_GRAPH_VERSION = "v4";
// Kept for backward compat with any external imports that referenced
// the old node-badges API. The new graph manages this internally.
export type LegacyNodeBadge = NodeBadge;
// Avoid an unused-symbol eslint warning while preserving API.
export type ExternalLinkType = typeof ExternalLink;
