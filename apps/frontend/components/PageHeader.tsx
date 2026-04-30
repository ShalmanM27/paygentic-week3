"use client";

// V1.4 — global nav. Pill-style icon nav with active highlight, breadcrumb
// support, and a primary "Host your agent" CTA. Replaces the older bare-
// text nav.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  Home,
  ListChecks,
  Moon,
  PlusCircle,
  Store,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCreditEvents } from "../lib/sse";
import { useTheme } from "../lib/theme";
import { ConnectionDot } from "./ui";

type Crumb = { href?: string; label: string };

interface PageHeaderProps {
  rightSlot?: ReactNode;
  /** Optional breadcrumbs rendered below the nav row. */
  crumbs?: Crumb[];
  /** Hide the primary CTA on pages where it'd be redundant. */
  hideHostCta?: boolean;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
  match: (p: string) => boolean;
  /** Marks the primary call-to-action item — visually emphasized. */
  primary?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: Home, match: (p) => p === "/" },
  {
    href: "/marketplace",
    label: "Marketplace",
    icon: Store,
    match: (p) => p === "/marketplace" || p.startsWith("/agent/"),
    primary: true,
  },
  {
    href: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    match: (p) => p.startsWith("/tasks"),
  },
  {
    href: "/flow",
    label: "Live Flow",
    icon: Activity,
    match: (p) => p.startsWith("/flow"),
  },
  {
    href: "/about",
    label: "About",
    icon: BookOpen,
    match: (p) => p.startsWith("/about"),
  },
];

export function PageHeader({
  rightSlot,
  crumbs,
  hideHostCta = false,
}: PageHeaderProps) {
  const { connected } = useCreditEvents();
  const { theme, toggle } = useTheme();
  const pathname = usePathname() ?? "/";
  const isAddAgentRoute = pathname.startsWith("/add-agent");

  return (
    <header className="border-b border-panel-border pb-3 mb-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-2 group"
            aria-label="CREDIT home"
          >
            <span className="w-7 h-7 rounded-full bg-gradient-to-br from-accent to-info flex items-center justify-center text-black font-bold text-xs">
              C
            </span>
            <span className="font-mono-tight text-lg font-semibold tracking-tight group-hover:text-accent transition-colors">
              CREDIT
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              const cls = active
                ? "bg-accent-soft text-accent border border-accent/40"
                : item.primary
                  ? "text-accent hover:text-black hover:bg-accent border border-accent/30 font-medium"
                  : "text-ink-dim hover:text-ink hover:bg-panel-cardHover border border-transparent";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors ${cls}`}
                >
                  <Icon size={14} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {/* Subtle SSE dot for ops; tooltip explains. */}
          <span
            className="hidden sm:flex items-center"
            title={connected ? "Live updates connected" : "Live updates disconnected"}
            aria-hidden
          >
            <ConnectionDot connected={connected} pulsing={connected} />
          </span>
          <button
            onClick={toggle}
            className="w-8 h-8 rounded-full border border-panel-borderStrong text-ink-dim hover:text-ink hover:bg-panel-cardHover transition-colors flex items-center justify-center"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          {rightSlot}
          {!hideHostCta && !isAddAgentRoute && (
            <Link
              href="/add-agent"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-accent text-black hover:bg-accent-dim transition-colors"
            >
              <PlusCircle size={14} />
              Host your agent
            </Link>
          )}
        </div>
      </div>
      {crumbs && crumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="mt-2 text-xs text-ink-dim font-mono-tight flex items-center gap-1 flex-wrap"
        >
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-dimmer">›</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-ink transition-colors">
                  {c.label}
                </Link>
              ) : (
                <span className="text-ink">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
    </header>
  );
}
