"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { credit } from "../../../lib/credit-client";
import { fmtTime } from "../../../lib/format";
import { tierFor } from "../../../lib/policy";
import { useCreditEvents } from "../../../lib/sse";
import { LocusCheckoutMount } from "../../../lib/locus-checkout";
import {
  Button,
  Card,
  Section,
  Tag,
  TxHash,
} from "../../../components/ui";
import { PageHeader } from "../../../components/PageHeader";
import type {
  ScoreReportCreated,
  ScoreReportResult,
  ScoreSummary,
} from "../../../lib/types";

interface Props {
  params: { wallet: string };
}

interface ScoreEvent {
  type: string;
  delta: number;
  reason: string;
  source?: string;
  createdAt: string | null;
}

type FlowState =
  | { state: "idle" }
  | { state: "creating-session" }
  | { state: "awaiting-payment"; sessionId: string; checkoutUrl: string | null }
  | { state: "fetching-result"; sessionId: string }
  | { state: "delivered"; report: ScoreReportResult }
  | { state: "cancelled" }
  | { state: "error"; message: string };

export default function ScorePage({ params }: Props) {
  const wallet = params.wallet.toLowerCase();
  const [summary, setSummary] = useState<ScoreSummary | null>(null);
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState>({ state: "idle" });
  const { events: sseEvents } = useCreditEvents();

  async function loadAll() {
    try {
      const [s, ev] = await Promise.all([
        credit.getScore(wallet),
        credit.getScoreEvents(wallet, 20),
      ]);
      setSummary(s);
      setEvents(ev as unknown as ScoreEvent[]);
      setErrMsg(null);
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, [wallet]);

  // Refetch on score.changed for our borrower
  useEffect(() => {
    if (sseEvents.length === 0 || !summary) return;
    const last = sseEvents[0]!;
    if (last.kind === "score.changed") {
      loadAll();
    }
  }, [sseEvents]);

  // Trend computation: most recent score_recomputed delta (+/-)
  const trend = (() => {
    const recent = events.find((e) => e.type === "score_recomputed");
    if (!recent) return "flat";
    if (recent.delta > 0) return "up";
    if (recent.delta < 0) return "down";
    return "flat";
  })();

  const componentsValues =
    flow.state === "delivered"
      ? flow.report.components
      : null;

  if (errMsg && !summary) {
    return (
      <main className="min-h-screen p-12 max-w-3xl mx-auto text-center">
        <p className="text-danger font-mono-tight">error: {errMsg}</p>
        <p className="mt-4 text-sm">
          <Link href="/" className="text-info hover:underline">
            ← Dashboard
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto space-y-8">
      <PageHeader />
      <header className="border-b border-panel-border pb-4">
        <h1 className="font-mono-tight text-xl font-semibold tracking-tight">
          Credit Score
        </h1>
        <div className="mt-1">
          <TxHash hash={wallet} truncate={false} />
        </div>
      </header>

      {/* Score card */}
      <section className="text-center py-6">
        {loading ? (
          <p className="text-ink-dimmer font-mono-tight">Loading…</p>
        ) : summary ? (
          <>
            <div className="text-7xl font-mono-tight tabular-nums text-accent">
              {summary.score}
            </div>
            <div className="mt-3 flex items-center justify-center gap-3">
              <Tag variant="accent" className="text-base px-3 py-1">
                {summary.tier ?? tierFor(summary.score)}
              </Tag>
              <TrendArrow trend={trend} />
            </div>
            <div className="mt-2 text-xs text-ink-dimmer font-mono-tight">
              {summary.openLoans} open · {summary.defaultCount} defaults
            </div>
          </>
        ) : (
          <p className="text-ink-dimmer font-mono-tight">no data</p>
        )}
      </section>

      {/* Components breakdown */}
      <Section title="Components">
        <Card className="p-4 space-y-3">
          <ComponentBar
            label="delivery success rate"
            value={componentsValues?.deliverySuccessRate ?? null}
            kind="rate"
          />
          <ComponentBar
            label="refund rate"
            value={componentsValues?.refundRate ?? null}
            kind="rate"
          />
          <ComponentBar
            label="repayment punctuality"
            value={componentsValues?.repaymentPunctuality ?? null}
            kind="rate"
          />
          <ComponentRow
            label="default count"
            value={componentsValues?.defaultCount}
          />
          <ComponentRow
            label="lifetime repaid (USDC)"
            value={componentsValues?.lifetimeRepaid}
            decimals={4}
          />
          <ComponentRow
            label="open loan count"
            value={componentsValues?.openLoanCount}
          />
          {!componentsValues && (
            <p className="text-xs text-ink-dimmer text-center pt-1 font-mono-tight">
              Buy the full report below to populate components.
            </p>
          )}
        </Card>
      </Section>

      {/* Public events feed */}
      <Section title="Recent score events">
        <Card>
          {events.length === 0 ? (
            <div className="p-6 text-center text-ink-dimmer text-xs font-mono-tight">
              No score events yet.
            </div>
          ) : (
            <table className="w-full text-xs font-mono-tight">
              <thead>
                <tr className="border-b border-panel-border text-[10px] uppercase tracking-widest text-ink-dim">
                  <th className="text-left font-medium px-3 py-2">Type</th>
                  <th className="text-right font-medium px-3 py-2">Δ</th>
                  <th className="text-left font-medium px-3 py-2">Reason</th>
                  <th className="text-right font-medium px-3 py-2">Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr
                    key={i}
                    className="border-b border-panel-border last:border-b-0"
                  >
                    <td className="px-3 py-1.5 text-ink-dim">{e.type}</td>
                    <td
                      className={`px-3 py-1.5 text-right ${
                        e.delta > 0
                          ? "text-accent"
                          : e.delta < 0
                            ? "text-danger"
                            : "text-ink-dim"
                      }`}
                    >
                      {e.delta > 0 ? `+${e.delta}` : e.delta}
                    </td>
                    <td className="px-3 py-1.5 text-ink truncate max-w-xs">
                      {e.reason}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink-dimmer">
                      {fmtTime(e.createdAt ?? undefined)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Section>

      <div className="border-t border-panel-border pt-8">
        <BuyReportPanel wallet={wallet} flow={flow} setFlow={setFlow} />
      </div>

      {flow.state === "delivered" && <FullReport report={flow.report} />}
    </main>
  );
}

function TrendArrow({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up")
    return <span className="text-accent text-sm">▲ rising</span>;
  if (trend === "down")
    return <span className="text-danger text-sm">▼ falling</span>;
  return <span className="text-ink-dimmer text-sm">— flat</span>;
}

function ComponentBar({
  label,
  value,
  kind,
}: {
  label: string;
  value: number | null;
  kind: "rate";
}) {
  const filled = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs font-mono-tight">
        <span className="text-ink-dim">{label}</span>
        <span className="tabular-nums">
          {value === null ? "—" : (value * 100).toFixed(0) + "%"}
        </span>
      </div>
      <div className="h-1.5 bg-panel-cardHover rounded overflow-hidden">
        <div
          className={`h-full ${kind === "rate" ? "bg-accent" : "bg-info"}`}
          style={{ width: `${filled * 100}%` }}
        />
      </div>
    </div>
  );
}

function ComponentRow({
  label,
  value,
  decimals,
}: {
  label: string;
  value: number | undefined;
  decimals?: number;
}) {
  return (
    <div className="flex items-baseline justify-between text-xs font-mono-tight border-t border-panel-border pt-2">
      <span className="text-ink-dim">{label}</span>
      <span className="tabular-nums">
        {value === undefined
          ? "—"
          : decimals !== undefined
            ? value.toFixed(decimals)
            : value}
      </span>
    </div>
  );
}

function BuyReportPanel({
  wallet,
  flow,
  setFlow,
}: {
  wallet: string;
  flow: FlowState;
  setFlow: (f: FlowState) => void;
}) {
  async function start() {
    setFlow({ state: "creating-session" });
    try {
      const created: ScoreReportCreated = await credit.createScoreReport(wallet);
      setFlow({
        state: "awaiting-payment",
        sessionId: created.sessionId,
        checkoutUrl: created.checkoutUrl,
      });
    } catch (e) {
      setFlow({ state: "error", message: (e as Error).message });
    }
  }

  async function onPaid() {
    if (flow.state !== "awaiting-payment") return;
    setFlow({ state: "fetching-result", sessionId: flow.sessionId });
    // Poll: webhook may be async, /result returns 402 until CLAIMABLE.
    for (let i = 0; i < 5; i++) {
      try {
        const r = await credit.getScoreReportResult(flow.sessionId);
        setFlow({ state: "delivered", report: r });
        return;
      } catch (e) {
        const status = (e as Error & { status?: number }).status;
        if (status === 402) {
          await new Promise((res) => setTimeout(res, 1000));
          continue;
        }
        setFlow({ state: "error", message: (e as Error).message });
        return;
      }
    }
    setFlow({
      state: "error",
      message: "report not delivered after 5 polls",
    });
  }

  return (
    <Card className="p-6 text-center space-y-4">
      <div>
        <h2 className="font-mono-tight text-lg font-semibold tracking-tight">
          Full credit report
        </h2>
        <p className="text-sm text-ink-dim mt-1">
          Score history, component breakdown, all events. <b>$0.002 USDC</b>.
        </p>
      </div>

      {flow.state === "idle" || flow.state === "cancelled" || flow.state === "error" ? (
        <>
          <Button variant="primary" size="lg" onClick={start}>
            Buy full report — $0.002 USDC
          </Button>
          {flow.state === "cancelled" && (
            <p className="text-warn text-xs font-mono-tight">cancelled</p>
          )}
          {flow.state === "error" && (
            <p className="text-danger text-xs font-mono-tight">
              {flow.message}
            </p>
          )}
        </>
      ) : flow.state === "creating-session" ? (
        <p className="text-ink-dimmer font-mono-tight text-sm">
          Creating Locus session…
        </p>
      ) : flow.state === "awaiting-payment" ? (
        <div className="space-y-2">
          <p className="text-ink-dim font-mono-tight text-xs">
            session{" "}
            <span className="text-accent">
              {flow.sessionId.slice(0, 16)}…
            </span>
          </p>
          <LocusCheckoutMount
            sessionId={flow.sessionId}
            mode="embedded"
            onPaid={onPaid}
            onCancel={() => setFlow({ state: "cancelled" })}
            onError={(e) => setFlow({ state: "error", message: e.message })}
          />
          <div className="pt-3 border-t border-panel-border">
            <p className="text-[10px] text-ink-dimmer font-mono-tight mb-2">
              Demo / offline-mode rehearsal:
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await credit.simulatePay(flow.sessionId);
                  await onPaid();
                } catch (e) {
                  setFlow({
                    state: "error",
                    message: (e as Error).message,
                  });
                }
              }}
            >
              ↳ Simulate payment (offline only)
            </Button>
          </div>
        </div>
      ) : flow.state === "fetching-result" ? (
        <p className="text-ink-dimmer font-mono-tight text-sm">
          Payment received — fetching report…
        </p>
      ) : null}
    </Card>
  );
}

function FullReport({ report }: { report: ScoreReportResult }) {
  return (
    <Section title={`Full report — ${report.wallet.slice(0, 12)}…`}>
      <Card className="p-6 space-y-6">
        <div className="flex items-baseline justify-between border-b border-panel-border pb-4">
          <div>
            <div className="text-5xl font-mono-tight tabular-nums text-accent">
              {report.score}
            </div>
            <Tag variant="accent" className="mt-2">
              {report.tier}
            </Tag>
          </div>
          <p className="text-xs text-ink-dimmer font-mono-tight">
            Delivered. Locked from further changes.
          </p>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
            Components
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono-tight">
            {Object.entries(report.components).map(([k, v]) => (
              <div
                key={k}
                className="border border-panel-border rounded p-2 bg-panel-card"
              >
                <div className="text-ink-dim">{k}</div>
                <div className="text-ink text-base tabular-nums">
                  {typeof v === "number" ? v : "—"}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
            Events ({report.events.length})
          </div>
          {report.events.length === 0 ? (
            <p className="text-xs text-ink-dimmer">No events recorded.</p>
          ) : (
            <table className="w-full text-xs font-mono-tight">
              <thead>
                <tr className="border-b border-panel-border text-[10px] uppercase tracking-widest text-ink-dim">
                  <th className="text-left font-medium px-2 py-1">Type</th>
                  <th className="text-right font-medium px-2 py-1">Δ</th>
                  <th className="text-left font-medium px-2 py-1">Reason</th>
                  <th className="text-right font-medium px-2 py-1">Time</th>
                </tr>
              </thead>
              <tbody>
                {report.events.map((e, i) => (
                  <tr
                    key={i}
                    className="border-b border-panel-border last:border-b-0"
                  >
                    <td className="px-2 py-1 text-ink-dim">{e.type}</td>
                    <td
                      className={`px-2 py-1 text-right ${
                        e.delta > 0 ? "text-accent" : "text-danger"
                      }`}
                    >
                      {e.delta > 0 ? `+${e.delta}` : e.delta}
                    </td>
                    <td className="px-2 py-1 truncate max-w-xs">{e.reason}</td>
                    <td className="px-2 py-1 text-right text-ink-dimmer">
                      {fmtTime(e.createdAt ?? undefined)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </Section>
  );
}
