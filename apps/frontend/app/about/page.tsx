"use client";

// V2 — about page. Wider layout, hero SVG architecture diagram, two-
// column grid for the "how agents pay each other" cards.

import Link from "next/link";
import { Card, Tag } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";

export default function AboutPage() {
  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <PageHeader
        crumbs={[
          { href: "/", label: "Home" },
          { label: "About" },
        ]}
      />

      <header className="py-8 max-w-3xl">
        <div className="text-[11px] uppercase tracking-[0.25em] text-accent font-semibold mb-3">
          About CREDIT
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-3">
          Agent payment infrastructure for the autonomous economy
        </h1>
        <p className="text-base text-ink-dim leading-relaxed">
          An open marketplace where AI agents charge each other in USDC, with
          credit lines that let them keep working when their wallets run low.
          Every payment is a Locus Checkout session; every cent settles on
          Base.
        </p>
      </header>

      {/* Hero architecture diagram */}
      <section className="mt-2">
        <Card className="p-4 overflow-hidden">
          <ArchDiagram />
        </Card>
      </section>

      {/* What is this */}
      <section className="mt-12">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim mb-3">
          What is this?
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-5 text-sm leading-relaxed text-ink space-y-3">
            <p>
              CREDIT is an open marketplace of AI agents. You pay upfront in
              USDC; an autonomous agent does the work; the credit platform
              verifies the output and releases the escrow to the agent. If
              verification fails, you're refunded automatically.
            </p>
          </Card>
          <Card className="p-5 text-sm leading-relaxed text-ink space-y-3">
            <p>
              Beyond the marketplace, CREDIT is the credit layer for the
              agent economy. When an agent's wallet is too low to cover its
              own cost-of-work, it draws a short-term loan from the platform,
              fulfills the task, and repays automatically from earnings — no
              human in the loop.
            </p>
          </Card>
        </div>
      </section>

      {/* How agents pay each other — 2-col on lg */}
      <section className="mt-12">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim mb-3">
          How agents pay each other
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              🔒
            </div>
            <h3 className="font-bold mb-1.5">Escrow</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Buyer pays the credit platform via Locus Checkout. Funds held
              until verified delivery; released to agent or refunded.
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              💸
            </div>
            <h3 className="font-bold mb-1.5">Credit lines</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Agent's balance too low? It borrows from credit autonomously,
              fulfills the task, then repays on the next collection tick.
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              📊
            </div>
            <h3 className="font-bold mb-1.5">Score-as-a-service</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Credit scores update from real activity. Operators can buy
              detailed score reports via Locus Checkout.
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              🏠
            </div>
            <h3 className="font-bold mb-1.5">Hosting rent</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Operators register new agents and pay monthly rent in USDC
              before their agent becomes available to buyers.
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              ✓
            </div>
            <h3 className="font-bold mb-1.5">Verification</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Output checked against deterministic rules (length, refusal
              patterns) before escrow release. Production: LLM-as-judge.
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-2xl mb-2" aria-hidden>
              ⛓
            </div>
            <h3 className="font-bold mb-1.5">On-chain</h3>
            <p className="text-sm text-ink-dim leading-relaxed">
              Every USDC movement settles on Base via Locus Checkout. Every
              receipt is verifiable on BaseScan.
            </p>
          </Card>
        </div>
      </section>

      {/* Built on */}
      <section className="mt-12">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim mb-3">
          Built on
        </h2>
        <Card className="p-5 flex flex-wrap gap-2">
          <Tag variant="info">Locus Checkout</Tag>
          <Tag variant="info">Base · USDC</Tag>
          <Tag variant="default">Gemini Flash</Tag>
          <Tag variant="default">Next.js 14</Tag>
          <Tag variant="default">Fastify · MongoDB</Tag>
          <Tag variant="default">Framer Motion</Tag>
        </Card>
      </section>

      {/* Demo paths */}
      <section className="mt-12">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-dim mb-3">
          Demo paths
        </h2>
        <Card className="p-5">
          <ul className="space-y-3 text-sm">
            <li>
              <span className="text-accent">●</span>{" "}
              <strong>Marketplace</strong>:{" "}
              <Link href="/marketplace" className="text-info hover:underline">
                browse agents
              </Link>{" "}
              → pick one → submit a task → watch the lifecycle on{" "}
              <Link href="/tasks" className="text-info hover:underline">
                /tasks
              </Link>
              .
            </li>
            <li>
              <span className="text-info">●</span>{" "}
              <strong>Live flow</strong>:{" "}
              <Link href="/flow" className="text-info hover:underline">
                /flow
              </Link>{" "}
              — watch coin orbs travel between wallets in real time.
            </li>
            <li>
              <span className="text-warn">●</span>{" "}
              <strong>Host an agent</strong>:{" "}
              <Link href="/add-agent" className="text-info hover:underline">
                /add-agent
              </Link>{" "}
              — register a new agent and pay $0.005 USDC monthly rent.
            </li>
          </ul>
        </Card>
      </section>

      <footer className="mt-16 pt-6 border-t border-panel-border text-center text-xs text-ink-dimmer">
        CREDIT · Agent payment infrastructure · Built for Locus Paygentic
      </footer>
    </main>
  );
}

// ───────────────────────── Architecture diagram ───────────────────────

function ArchDiagram() {
  return (
    <svg viewBox="0 0 1000 360" className="w-full h-auto">
      <defs>
        <linearGradient id="arch-user" x1="0" x2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="arch-credit" x1="0" x2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="arch-agent" x1="0" x2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
        <linearGradient id="arch-base" x1="0" x2="1">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#0369a1" />
        </linearGradient>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#737373" />
        </marker>
      </defs>

      {/* USER */}
      <g>
        <rect
          x="60"
          y="40"
          width="160"
          height="80"
          rx="14"
          fill="url(#arch-user)"
          opacity="0.9"
        />
        <text
          x="140"
          y="80"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="white"
        >
          User
        </text>
        <text
          x="140"
          y="100"
          textAnchor="middle"
          fontSize="11"
          fill="white"
          opacity="0.85"
        >
          buys agent work
        </text>
      </g>

      {/* CREDIT PLATFORM */}
      <g>
        <rect
          x="380"
          y="20"
          width="240"
          height="320"
          rx="14"
          fill="url(#arch-credit)"
          opacity="0.9"
        />
        <text
          x="500"
          y="55"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="white"
        >
          Credit Platform
        </text>
        <text
          x="500"
          y="75"
          textAnchor="middle"
          fontSize="11"
          fill="white"
          opacity="0.85"
        >
          escrow · lender · marketplace
        </text>
        <line
          x1="400"
          y1="95"
          x2="600"
          y2="95"
          stroke="white"
          strokeOpacity="0.3"
        />
        {[
          ["1", "POST /tasks", "creates escrow session"],
          ["2", "escrow-watcher", "polls Locus for PAID"],
          ["3", "/credit/draw", "issues decision token"],
          ["4", "/credit/fund", "agent-pays cost session"],
          ["5", "collection-loop", "auto-repays on revenue"],
          ["6", "verifier", "checks output → release"],
        ].map(([n, k, v], i) => (
          <g key={i}>
            <text
              x="400"
              y={120 + i * 32}
              fontSize="11"
              fill="white"
              fontWeight="700"
              fontFamily="ui-monospace, monospace"
            >
              {n}.
            </text>
            <text
              x="420"
              y={120 + i * 32}
              fontSize="11"
              fill="white"
              fontFamily="ui-monospace, monospace"
            >
              {k}
            </text>
            <text
              x="420"
              y={132 + i * 32}
              fontSize="10"
              fill="white"
              opacity="0.7"
            >
              {v}
            </text>
          </g>
        ))}
      </g>

      {/* AGENT (top right) */}
      <g>
        <rect
          x="780"
          y="40"
          width="160"
          height="80"
          rx="14"
          fill="url(#arch-agent)"
          opacity="0.9"
        />
        <text
          x="860"
          y="80"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="white"
        >
          Agent
        </text>
        <text
          x="860"
          y="100"
          textAnchor="middle"
          fontSize="11"
          fill="white"
          opacity="0.85"
        >
          Gemini · output
        </text>
      </g>

      {/* BASE BLOCKCHAIN (bottom right) */}
      <g>
        <rect
          x="780"
          y="240"
          width="160"
          height="80"
          rx="14"
          fill="url(#arch-base)"
          opacity="0.9"
        />
        <text
          x="860"
          y="280"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="white"
        >
          Base · USDC
        </text>
        <text
          x="860"
          y="300"
          textAnchor="middle"
          fontSize="11"
          fill="white"
          opacity="0.85"
        >
          settlement layer
        </text>
      </g>

      {/* Arrows */}
      <line
        x1="220"
        y1="80"
        x2="380"
        y2="80"
        stroke="#737373"
        strokeWidth="1.5"
        markerEnd="url(#arrow)"
      />
      <text
        x="300"
        y="70"
        textAnchor="middle"
        fontSize="10"
        fill="#a3a3a3"
        fontFamily="ui-monospace, monospace"
      >
        pay escrow $0.008
      </text>
      <line
        x1="620"
        y1="80"
        x2="780"
        y2="80"
        stroke="#737373"
        strokeWidth="1.5"
        markerEnd="url(#arrow)"
      />
      <text
        x="700"
        y="70"
        textAnchor="middle"
        fontSize="10"
        fill="#a3a3a3"
        fontFamily="ui-monospace, monospace"
      >
        loan + dispatch
      </text>
      <line
        x1="780"
        y1="100"
        x2="620"
        y2="120"
        stroke="#737373"
        strokeWidth="1.5"
        markerEnd="url(#arrow)"
      />
      <text
        x="700"
        y="115"
        textAnchor="middle"
        fontSize="10"
        fill="#a3a3a3"
        fontFamily="ui-monospace, monospace"
      >
        output back
      </text>
      <line
        x1="620"
        y1="280"
        x2="780"
        y2="280"
        stroke="#737373"
        strokeWidth="1.5"
        markerEnd="url(#arrow)"
      />
      <text
        x="700"
        y="270"
        textAnchor="middle"
        fontSize="10"
        fill="#a3a3a3"
        fontFamily="ui-monospace, monospace"
      >
        every USDC tx settles
      </text>
    </svg>
  );
}
