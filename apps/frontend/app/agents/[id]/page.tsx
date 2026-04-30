"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { credit } from "../../../lib/credit-client";
import { fmtRelative, fmtTime, fmtPct } from "../../../lib/format";
import { rateFor, tierFor } from "../../../lib/policy";
import { useCreditEvents } from "../../../lib/sse";
import {
  Button,
  Card,
  Section,
  SessionId,
  StatusPill,
  Tag,
  TxHash,
  USDC,
} from "../../../components/ui";
import { PageHeader } from "../../../components/PageHeader";
import type { LoanRow } from "../../../lib/types";

interface Props {
  params: { id: string };
}

type AgentResponse = Awaited<ReturnType<typeof credit.getAgent>>;
type BalanceResponse = Awaited<ReturnType<typeof credit.getAgentBalance>>;
type LoanSessions = Awaited<ReturnType<typeof credit.getLoanSessions>>;

export default function AgentPage({ params }: Props) {
  const { id } = params;
  const [agent, setAgent] = useState<AgentResponse | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);
  const [loanSessions, setLoanSessions] = useState<Record<string, LoanSessions>>({});

  const { events } = useCreditEvents();

  async function load() {
    try {
      const ag = await credit.getAgent(id);
      setAgent(ag);
      setNotFound(false);
      setErr(null);
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status === 404) {
        setNotFound(true);
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadBalance(force = false) {
    setRefreshingBalance(true);
    try {
      const b = force
        ? await credit.getAgentBalanceForce(id)
        : await credit.getAgentBalance(id);
      setBalance(b);
    } catch {
      /* ignore */
    } finally {
      setRefreshingBalance(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    loadBalance(false);
  }, [id]);

  // Refetch on relevant SSE events
  useEffect(() => {
    if (events.length === 0) return;
    const last = events[0]!;
    const matches =
      ((last.kind === "loan.funded" ||
        last.kind === "loan.repaid" ||
        last.kind === "loan.defaulted" ||
        last.kind === "score.changed") &&
        "borrowerId" in last &&
        last.borrowerId === id);
    if (matches) {
      load();
    }
  }, [events, id]);

  async function expandLoan(loanId: string) {
    if (expandedLoanId === loanId) {
      setExpandedLoanId(null);
      return;
    }
    setExpandedLoanId(loanId);
    if (!loanSessions[loanId]) {
      try {
        const ls = await credit.getLoanSessions(loanId);
        setLoanSessions((prev) => ({ ...prev, [loanId]: ls }));
      } catch {
        /* ignore */
      }
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen p-6 max-w-5xl mx-auto">
        <p className="text-ink-dimmer font-mono-tight text-sm">Loading…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="min-h-screen p-12 max-w-5xl mx-auto text-center">
        <p className="text-ink-dim font-mono-tight">
          <span className="text-accent">{id}</span> not found.
        </p>
        <p className="mt-4 text-sm">
          <Link href="/flow" className="text-info hover:underline">
            ← Run a loan
          </Link>
        </p>
      </main>
    );
  }

  if (err) {
    return (
      <main className="min-h-screen p-6 max-w-5xl mx-auto">
        <p className="text-danger font-mono-tight text-sm">error: {err}</p>
      </main>
    );
  }

  if (!agent) return null;

  const b = agent.borrower;
  const t = agent.totals;
  const score = b.score;
  const tier = tierFor(score);
  const rate = rateFor(score);
  const limitAvailable = Math.max(0, b.limit - b.outstanding);

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto space-y-8">
      <PageHeader />
      <header className="flex items-baseline justify-between border-b border-panel-border pb-4">
        <div>
          <h1 className="font-mono-tight text-2xl font-semibold tracking-tight">
            {b.borrowerId}
          </h1>
          <div className="mt-1">
            <TxHash hash={b.walletAddress} truncate={false} />
          </div>
        </div>
        <div className="text-right space-y-1">
          <StatusPill status={b.status} />
          <div className="text-xs text-ink-dimmer font-mono-tight">
            updated {fmtRelative(b.updatedAt as string | undefined)}
          </div>
        </div>
      </header>

      {/* Identity */}
      <Section title="Identity & Connection">
        <Card className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm font-mono-tight">
          <Field
            label="Service URL"
            value={
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-ink-dim" />
                {b.serviceUrl ?? "—"}
              </span>
            }
          />
          <Field
            label="Registered at"
            value={fmtTime(b.registeredAt as string | undefined)}
          />
          <Field label="Wallet chain" value="base" />
          <Field
            label="API key prefix"
            value={b.apiKeyPrefix ? `${b.apiKeyPrefix}…` : "—"}
          />
        </Card>
      </Section>

      {/* Financials */}
      <Section title="Financials">
        <Card className="p-4 space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">
                Wallet balance
              </div>
              <div className="text-3xl font-mono-tight">
                <USDC amount={balance?.usdcBalance ?? null} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-dimmer font-mono-tight">
                {balance
                  ? `cached ${balance.cached ? "yes" : "no"} · ${fmtRelative(balance.fetchedAt)}`
                  : "—"}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={refreshingBalance}
                onClick={() => loadBalance(true)}
              >
                {refreshingBalance ? "…" : "↻ Refresh from Locus"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-3 border-t border-panel-border text-sm font-mono-tight">
            <Field label="Lifetime borrowed" value={<USDC amount={t.lifetimeBorrowed} />} />
            <Field label="Lifetime repaid" value={<USDC amount={t.lifetimeRepaid} />} />
            <Field label="Currently outstanding" value={<USDC amount={b.outstanding} />} />
            <Field label="Lifetime defaulted" value={<USDC amount={t.lifetimeDefaulted} />} />
          </div>
        </Card>
      </Section>

      {/* Credit Profile */}
      <Section title="Credit Profile">
        <Card className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm font-mono-tight">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">
              Score
            </div>
            <div className="text-3xl text-accent">{score}</div>
            <Tag variant="accent" className="mt-2">
              {tier}
            </Tag>
          </div>
          <Field label="Limit available" value={<USDC amount={limitAvailable} />} />
          <Field label="Total limit" value={<USDC amount={b.limit} />} />
          <Field
            label="Current rate"
            value={
              <span className={rate >= 0.99 ? "text-danger" : "text-warn"}>
                {fmtPct(rate, 0)}
              </span>
            }
          />
        </Card>
      </Section>

      {/* Loans */}
      <Section title={`Recent loans (${agent.recentLoans.length})`}>
        <Card className="overflow-x-auto">
          {agent.recentLoans.length === 0 ? (
            <div className="p-8 text-center text-ink-dimmer font-mono-tight text-sm">
              No loans yet.
            </div>
          ) : (
            <table className="w-full text-sm font-mono-tight">
              <thead>
                <tr className="border-b border-panel-border text-[10px] uppercase tracking-widest text-ink-dim">
                  <th className="text-left font-medium px-3 py-2">Loan ID</th>
                  <th className="text-left font-medium px-3 py-2">Drawn</th>
                  <th className="text-right font-medium px-3 py-2">Amount</th>
                  <th className="text-right font-medium px-3 py-2">Repay</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Disb. tx</th>
                  <th className="text-left font-medium px-3 py-2">Repay tx</th>
                </tr>
              </thead>
              <tbody>
                {agent.recentLoans.map((l: LoanRow) => (
                  <LoanRowDisplay
                    key={l.loanId}
                    loan={l}
                    expanded={expandedLoanId === l.loanId}
                    onToggle={() => expandLoan(l.loanId)}
                    sessions={loanSessions[l.loanId] ?? null}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Section>
    </main>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">
        {label}
      </div>
      <div className="text-ink">{value}</div>
    </div>
  );
}

function LoanRowDisplay({
  loan,
  expanded,
  onToggle,
  sessions,
}: {
  loan: LoanRow;
  expanded: boolean;
  onToggle: () => void;
  sessions: LoanSessions | null;
}) {
  return (
    <>
      <tr
        className="border-b border-panel-border last:border-b-0 hover:bg-panel-cardHover/40 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-accent">{loan.loanId}</td>
        <td className="px-3 py-2 text-ink-dim">{fmtTime(loan.createdAt)}</td>
        <td className="px-3 py-2 text-right">
          <USDC amount={loan.amount} />
        </td>
        <td className="px-3 py-2 text-right">
          <USDC amount={loan.repayAmount} />
        </td>
        <td className="px-3 py-2">
          <StatusPill status={loan.status} />
        </td>
        <td className="px-3 py-2">
          <TxHash hash={loan.disbursementTxHash} />
        </td>
        <td className="px-3 py-2">
          <TxHash hash={loan.repaymentTxHash} />
        </td>
      </tr>
      {expanded && (
        <tr className="bg-panel-cardHover/30">
          <td colSpan={7} className="px-6 py-4">
            {sessions === null ? (
              <p className="text-ink-dimmer text-xs">Loading sessions…</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <SessionSlot label="Customer" slot={sessions.customer} />
                <SessionSlot label="Disbursement" slot={sessions.disbursement} />
                <SessionSlot label="Repayment" slot={sessions.repayment} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function SessionSlot({
  label,
  slot,
}: {
  label: string;
  slot: { sessionId: string; status: string; txHash: string | null } | null;
}) {
  return (
    <div className="border border-panel-border rounded p-3 bg-panel-card">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">
        {label}
      </div>
      {slot === null ? (
        <span
          className="text-ink-dimmer text-xs"
          title="Customer session not yet threaded — see TODO in /loans/:id/sessions backend route"
        >
          — (not threaded) ⓘ
        </span>
      ) : (
        <div className="space-y-1">
          <SessionId id={slot.sessionId} />
          <div>
            <StatusPill status={slot.status} />
          </div>
          <TxHash hash={slot.txHash} />
        </div>
      )}
    </div>
  );
}
