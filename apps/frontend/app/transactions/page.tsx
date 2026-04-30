"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { credit } from "../../lib/credit-client";
import { fmtTime } from "../../lib/format";
import {
  Button,
  Card,
  SessionId,
  StatusPill,
  Tag,
  TxHash,
  USDC,
} from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";

const TYPES = [
  { key: "", label: "All" },
  { key: "draw", label: "Draw" },
  { key: "repayment", label: "Repayment" },
  { key: "score_sale", label: "Score sale" },
  { key: "default_writeoff", label: "Default writeoff" },
  { key: "borrower_revenue", label: "Borrower revenue" },
] as const;

const BORROWERS = [
  { key: "", label: "All" },
  { key: "agent-a", label: "Agent A" },
  { key: "agent-b", label: "Agent B" },
] as const;

type Row = {
  _id: string;
  type: string;
  borrowerId: string | null;
  amount: number;
  sessionId: string | null;
  txHash: string | null;
  locusTransactionId: string | null;
  status: string;
  loanId: string | null;
  createdAt: string;
};

const TYPE_VARIANT: Record<string, "accent" | "warn" | "danger" | "info" | "default"> = {
  draw: "warn",
  repayment: "accent",
  default_writeoff: "danger",
  score_sale: "info",
  borrower_revenue: "default",
};

export default function TransactionsPage() {
  const [type, setType] = useState("");
  const [borrowerId, setBorrowerId] = useState("");
  const [perPage, setPerPage] = useState(20);
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    credit
      .listTransactions({
        type: type || undefined,
        borrowerId: borrowerId || undefined,
        limit: perPage,
        offset: page * perPage,
      })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows as unknown as Row[]);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setErr(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type, borrowerId, perPage, page]);

  // Reset to page 0 when filters change
  useEffect(() => {
    setPage(0);
  }, [type, borrowerId, perPage]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const filtered = type !== "" || borrowerId !== "";

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <PageHeader
        rightSlot={
          <>
            <Link href="/flow" className="text-info text-sm hover:underline">
              Flow demo
            </Link>
          </>
        }
      />
      <div className="mb-6">
        <h1 className="font-mono-tight text-xl font-semibold tracking-tight">
          Transactions
        </h1>
        <p className="text-ink-dim text-sm mt-1 font-mono-tight">
          {loading
            ? "Loading…"
            : `${total} total${filtered ? ` · filtered to ${rows.length}` : ""}`}
        </p>
      </div>

      {/* Filter bar */}
      <div className="space-y-3 mb-6">
        <div className="flex gap-2 flex-wrap items-baseline">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim w-16">
            Type
          </span>
          {TYPES.map((t) => (
            <button
              key={t.key || "all"}
              onClick={() => setType(t.key)}
              className={`px-2 py-0.5 rounded text-xs font-mono-tight border transition-colors ${
                type === t.key
                  ? "bg-accent-soft text-accent border-accent/40"
                  : "bg-panel-cardHover text-ink-dim border-panel-border hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-baseline">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim w-16">
            Borrower
          </span>
          {BORROWERS.map((b) => (
            <button
              key={b.key || "all"}
              onClick={() => setBorrowerId(b.key)}
              className={`px-2 py-0.5 rounded text-xs font-mono-tight border transition-colors ${
                borrowerId === b.key
                  ? "bg-accent-soft text-accent border-accent/40"
                  : "bg-panel-cardHover text-ink-dim border-panel-border hover:text-ink"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-baseline">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim w-16">
            Per page
          </span>
          <select
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value))}
            className="bg-panel-cardHover border border-panel-border text-ink text-xs font-mono-tight px-2 py-0.5 rounded"
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-x-auto">
        {err ? (
          <div className="p-6 text-center text-danger font-mono-tight text-sm">
            error: {err}
          </div>
        ) : loading ? (
          <div className="p-6 text-center text-ink-dimmer font-mono-tight text-sm">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-ink-dimmer font-mono-tight text-sm">
            No transactions yet. Run a loan from the{" "}
            <Link href="/flow" className="text-info hover:underline">
              /flow page
            </Link>{" "}
            to populate.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-panel-border text-[10px] uppercase tracking-widest text-ink-dim">
                <th className="text-left font-medium px-3 py-2">Time</th>
                <th className="text-left font-medium px-3 py-2">Type</th>
                <th className="text-left font-medium px-3 py-2">Borrower</th>
                <th className="text-right font-medium px-3 py-2">Amount</th>
                <th className="text-left font-medium px-3 py-2">Session</th>
                <th className="text-left font-medium px-3 py-2">Tx</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r._id}
                  className="border-b border-panel-border last:border-b-0 hover:bg-panel-cardHover/40 font-mono-tight"
                >
                  <td className="px-3 py-2 text-ink-dim">
                    {fmtTime(r.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <Tag variant={TYPE_VARIANT[r.type] ?? "default"}>
                      {r.type}
                    </Tag>
                  </td>
                  <td className="px-3 py-2 text-ink-dim">
                    {r.borrowerId ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <USDC amount={r.amount} />
                  </td>
                  <td className="px-3 py-2">
                    <SessionId id={r.sessionId} />
                  </td>
                  <td className="px-3 py-2">
                    <TxHash hash={r.txHash} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pagination */}
      {!loading && rows.length > 0 && (
        <div className="flex items-center justify-between mt-4 text-sm font-mono-tight">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </Button>
          <span className="text-ink-dim">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Button>
        </div>
      )}
    </main>
  );
}
