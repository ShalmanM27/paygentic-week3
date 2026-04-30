"use client";

// Post-submission rent payment page. Mounts the Locus Checkout SDK on the
// rent session, watches subscription status via SSE + polling, and shows a
// 4-step activation timeline.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { credit } from "../../../lib/credit-client";
import { fmtRelative } from "../../../lib/format";
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
  AgentRow,
  AgentSubscriptionRow,
} from "../../../lib/types";

interface Props {
  params: { subscriptionId: string };
}

export default function ActivateAgentPage({ params }: Props) {
  const { subscriptionId } = params;
  const [sub, setSub] = useState<AgentSubscriptionRow | null>(null);
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const lastFetchRef = useRef(0);
  const { events } = useCreditEvents();

  async function fetchSub(): Promise<void> {
    lastFetchRef.current = Date.now();
    try {
      const r = await credit.getSubscription(subscriptionId);
      setSub(r.subscription);
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
    fetchSub();
    const t = setInterval(() => {
      if (Date.now() - lastFetchRef.current > 10_000) {
        fetchSub();
      }
    }, 5_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  // Refetch on relevant SSE events
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    const isRelevant =
      (last.kind === "agent.activated" &&
        last.subscriptionId === subscriptionId) ||
      (last.kind === "subscription.expired" &&
        last.subscriptionId === subscriptionId) ||
      (last.kind === "agent.registered" &&
        last.subscriptionId === subscriptionId);
    if (isRelevant) fetchSub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, subscriptionId]);

  async function simulatePay(): Promise<void> {
    if (!sub) return;
    setSimulating(true);
    try {
      await credit.simulatePay(sub.escrowSessionId);
      setTimeout(() => fetchSub(), 500);
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
        <p className="text-ink-dimmer text-sm">Loading subscription…</p>
      </main>
    );
  }
  if (notFound) {
    return (
      <main className="min-h-screen p-12 max-w-3xl mx-auto text-center">
        <PageHeader />
        <p className="text-ink-dim">
          Subscription <span className="text-accent">{subscriptionId}</span>{" "}
          not found.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/add-agent" className="text-info hover:underline">
            ← Start over
          </Link>
        </p>
      </main>
    );
  }
  if (err && !sub) {
    return (
      <main className="min-h-screen p-6 max-w-3xl mx-auto">
        <PageHeader />
        <Card className="p-6 text-danger text-sm">{err}</Card>
      </main>
    );
  }
  if (!sub) return null;

  const paid = sub.escrowSessionStatus === "PAID";
  const activated = sub.status === "ACTIVE";
  const expired = sub.status === "EXPIRED";
  const live = activated && agent?.isActive === true;

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <PageHeader
        rightSlot={
          <Link href="/" className="text-info text-sm hover:underline">
            ← Marketplace
          </Link>
        }
      />

      <header className="space-y-1 pb-4 border-b border-panel-border mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Activating your agent
        </h1>
        <div className="flex items-center gap-2 text-sm font-mono-tight">
          <span className="text-accent">{sub.subscriptionId}</span>
          <span className="text-ink-dimmer">·</span>
          <Tag variant="default">
            {agent?.emoji ? `${agent.emoji} ` : ""}
            {sub.agentId}
          </Tag>
          <span className="text-ink-dimmer text-xs">
            created {fmtRelative(sub.createdAt)}
          </span>
        </div>
      </header>

      {!paid && !expired && (
        <Section title={`Pay $${sub.rentUsdc.toFixed(4)} USDC rent`}>
          <Card className="p-4 space-y-4">
            <LocusCheckoutMount
              sessionId={sub.escrowSessionId}
              mode="embedded"
              onPaid={() => fetchSub()}
              onError={(e) => setErr(e.message)}
              onCancel={() => {
                /* user can retry */
              }}
            />
            <div className="flex items-center justify-between text-xs font-mono-tight pt-3 border-t border-panel-border">
              <SessionId id={sub.escrowSessionId} />
              <Button
                variant="secondary"
                size="sm"
                disabled={simulating}
                onClick={simulatePay}
                title="Offline-mode demo helper"
              >
                {simulating ? "Simulating…" : "↳ Simulate payment (offline)"}
              </Button>
            </div>
          </Card>
        </Section>
      )}

      {expired && (
        <Section title="Subscription expired">
          <Card className="p-4 text-sm text-ink-dim">
            The rent session expired before payment. Start over from{" "}
            <Link href="/add-agent" className="text-info hover:underline">
              /add-agent
            </Link>
            .
          </Card>
        </Section>
      )}

      <Section title="Activation status">
        <Card>
          <ol>
            <Step
              label="Subscription created"
              completed
              detail={`agent ${sub.agentId} · operator ${sub.operatorId}`}
            />
            <Step
              label="Payment received"
              completed={paid}
              pulsing={!paid && !expired}
              detail={
                paid ? <TxHash hash={sub.escrowTxHash} /> : "Awaiting payment…"
              }
              color={expired ? "default" : "accent"}
            />
            <Step
              label="Agent activated"
              completed={activated}
              pulsing={paid && !activated}
              detail={
                activated
                  ? `coverage ends ${
                      sub.coverageEndAt
                        ? new Date(sub.coverageEndAt).toLocaleDateString()
                        : "—"
                    }`
                  : paid
                    ? "Subscription-watcher activating…"
                    : null
              }
            />
            <Step
              label="Live on marketplace"
              completed={live}
              detail={
                live ? (
                  <Link
                    href={`/agent/${encodeURIComponent(sub.agentId)}`}
                    className="text-info hover:underline"
                  >
                    → View {agent?.displayName ?? sub.agentId}
                  </Link>
                ) : null
              }
            />
          </ol>
        </Card>
      </Section>

      {agent && (
        <Section title="What you registered">
          <Card className="p-4 space-y-2 text-sm">
            <Row label="Display name">{agent.displayName}</Row>
            <Row label="Category">
              <Tag variant="default">{agent.category}</Tag>
            </Row>
            <Row label="Pricing">
              <USDC amount={agent.pricingUsdc} /> per task
            </Row>
            <Row label="Wallet">
              <TxHash hash={agent.walletAddress} />
            </Row>
            <Row label="Service URL">
              <span className="font-mono-tight text-xs">
                {agent.serviceUrl}
              </span>
            </Row>
          </Card>
        </Section>
      )}

      <Section title="What happens next">
        <Card className="p-4 text-sm text-ink-dim leading-relaxed">
          Once rent settles, your agent appears on the marketplace home page.
          Buyers can submit tasks; the credit platform holds escrow, dispatches
          to your service URL, verifies output, and releases funds to your
          wallet. Coverage expires automatically after{" "}
          <Tag variant="default">30 days</Tag>; renewal will require a new
          rent session.
        </Card>
      </Section>
    </main>
  );
}

function Step({
  label,
  completed,
  pulsing = false,
  color = "accent",
  detail,
}: {
  label: string;
  completed: boolean;
  pulsing?: boolean;
  color?: "accent" | "default";
  detail?: React.ReactNode;
}) {
  const dot =
    !completed
      ? "border-panel-borderStrong bg-transparent"
      : color === "accent"
        ? "border-accent bg-accent"
        : "border-panel-borderStrong bg-panel-borderStrong";
  return (
    <li className="flex items-start gap-3 px-4 py-3 border-b border-panel-border last:border-b-0">
      <span
        className={`w-3 h-3 rounded-full border-2 mt-1 ${dot} ${
          pulsing && completed ? "animate-pulse" : ""
        } ${pulsing && !completed ? "animate-pulse border-info" : ""}`}
      />
      <div className="flex-1 min-w-0">
        <span
          className={
            completed ? "text-ink font-medium" : "text-ink-dimmer"
          }
        >
          {label}
        </span>
        {detail !== undefined && detail !== null && (
          <div className="text-xs text-ink-dim mt-1">{detail}</div>
        )}
      </div>
    </li>
  );
}

function Row({
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
