"use client";

// Shared header chrome for the dashboard, transactions, agents, and score
// pages. /flow has its own bespoke header (demo centerpiece) and is exempt.

import Link from "next/link";
import type { ReactNode } from "react";
import { useCreditEvents } from "../lib/sse";
import { ConnectionDot } from "./ui";

export function PageHeader({ rightSlot }: { rightSlot?: ReactNode }) {
  const { connected } = useCreditEvents();
  return (
    <header className="flex items-center justify-between border-b border-panel-border pb-4 mb-6">
      <div className="flex items-baseline gap-4">
        <Link
          href="/"
          className="font-mono-tight text-xl font-semibold tracking-tight hover:text-accent transition-colors"
        >
          CREDIT
        </Link>
        <span className="flex items-center gap-1.5 text-xs text-ink-dim">
          <ConnectionDot connected={connected} />
          {connected ? "live" : "disconnected"}
        </span>
      </div>
      {rightSlot && <div className="flex items-baseline gap-3">{rightSlot}</div>}
    </header>
  );
}
