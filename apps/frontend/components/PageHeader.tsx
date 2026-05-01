"use client";

// Editorial nav. Fixed-height (h-16) glass strip with three regions:
//   LEFT  — gradient LC badge + brand cluster (hidden on mobile, only
//            badge shows). All text marked whitespace-nowrap so nothing
//            wraps onto a second line.
//   CENTER — five typographic links with center-grow gradient
//            underline, whitespace-nowrap.
//   RIGHT  — theme toggle + small "Host" pill.
//
// Breadcrumbs are removed everywhere. The component still accepts
// (and ignores) `crumbs` for backwards-compat with stale callers.
// `rightSlot` is preserved because some pages used it for inline
// links — but new design treats those as breadcrumbs and ignores
// them too. The active underline is enough orientation.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AnimatePresence,
  motion,
  useScroll,
  useTransform,
} from "framer-motion";
import { Moon, Plus, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useCreditEvents } from "../lib/sse";
import { useTheme } from "../lib/theme";
import { ConnectionDot } from "./ui";
import { Tooltip } from "./Tooltip";

interface NavItem {
  href: string;
  label: string;
  match: (p: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", match: (p) => p === "/" },
  {
    href: "/marketplace",
    label: "Marketplace",
    match: (p) => p === "/marketplace" || p.startsWith("/agent/"),
  },
  { href: "/tasks", label: "Tasks", match: (p) => p.startsWith("/tasks") },
  { href: "/flow", label: "Live Flow", match: (p) => p.startsWith("/flow") },
  { href: "/about", label: "About", match: (p) => p.startsWith("/about") },
];

interface PageHeaderProps {
  /** Deprecated — ignored. Inline link slot from older design. */
  rightSlot?: ReactNode;
  /** Deprecated — breadcrumbs are gone. Kept so existing call sites
   *  still type-check. */
  crumbs?: Array<{ href?: string; label: string }>;
  hideHostCta?: boolean;
}

export function PageHeader({ hideHostCta = false }: PageHeaderProps) {
  const { connected } = useCreditEvents();
  const { theme, toggle } = useTheme();
  const pathname = usePathname() ?? "/";
  const isAddAgentRoute = pathname.startsWith("/add-agent");
  const { scrollY } = useScroll();
  const headerBg = useTransform(
    scrollY,
    [0, 80],
    theme === "light"
      ? ["rgba(255,255,255,0.55)", "rgba(255,255,255,0.85)"]
      : ["rgba(0,0,0,0.40)", "rgba(0,0,0,0.70)"],
  );
  const borderColor =
    theme === "light" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)";

  return (
    <motion.header
      className="sticky top-0 z-50 backdrop-blur-2xl border-b"
      style={{ background: headerBg, borderBottomColor: borderColor }}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
        {/* LEFT — brand */}
        <Link
          href="/"
          className="flex items-center gap-3 shrink-0 group"
          aria-label="Locus Credit home"
        >
          <motion.div
            className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 via-cyan-400 to-blue-500 flex items-center justify-center shadow-[0_0_20px_rgba(52,211,153,0.25)] group-hover:shadow-[0_0_28px_rgba(52,211,153,0.40)] transition-shadow"
            whileHover={{ scale: 1.06, rotate: -4 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 320, damping: 18 }}
            style={{ willChange: "transform" }}
          >
            <span className="text-black font-bold text-xs tracking-tight">
              LC
            </span>
          </motion.div>
          <div className="hidden sm:flex flex-col leading-none">
            <span className="font-semibold text-sm tracking-tight text-white whitespace-nowrap">
              Locus Credit
            </span>
            <span className="text-[10px] tracking-[0.15em] text-gray-500 uppercase whitespace-nowrap mt-1">
              autonomous · 2026
            </span>
          </div>
        </Link>

        {/* CENTER — typographic nav (no icons) */}
        <nav className="hidden md:flex items-center gap-1 flex-1 justify-center">
          {NAV_ITEMS.map((item) => {
            const isActive = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative px-4 py-2 text-sm transition-colors whitespace-nowrap ${
                  isActive
                    ? "text-white font-medium"
                    : "text-gray-400 hover:text-white font-normal"
                }`}
              >
                {item.label}
                <span
                  aria-hidden
                  className={`absolute bottom-0 left-1/2 -translate-x-1/2 h-px bg-gradient-to-r from-transparent via-emerald-400 to-transparent transition-[width] duration-300 ${
                    isActive ? "w-3/4" : "w-0 group-hover:w-3/4"
                  }`}
                />
              </Link>
            );
          })}
        </nav>

        {/* RIGHT — actions */}
        <div className="flex items-center gap-3 shrink-0">
          <Tooltip
            label={connected ? "Live updates · SSE" : "Live disconnected"}
            side="bottom"
          >
            <span className="hidden sm:flex items-center" aria-hidden>
              <ConnectionDot connected={connected} pulsing={connected} />
            </span>
          </Tooltip>
          <Tooltip
            label={theme === "dark" ? "Switch to light" : "Switch to dark"}
            side="bottom"
          >
            <motion.button
              onClick={toggle}
              whileTap={{ scale: 0.9 }}
              className="w-9 h-9 rounded-full border border-white/15 text-gray-300 hover:text-white hover:bg-white/5 transition-colors flex items-center justify-center overflow-hidden shrink-0"
              aria-label={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={theme}
                  initial={{ rotate: -180, scale: 0.4, opacity: 0 }}
                  animate={{ rotate: 0, scale: 1, opacity: 1 }}
                  exit={{ rotate: 180, scale: 0.4, opacity: 0 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  style={{ display: "inline-flex" }}
                >
                  {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                </motion.span>
              </AnimatePresence>
            </motion.button>
          </Tooltip>
          {!hideHostCta && !isAddAgentRoute && (
            <Tooltip label="Register a new agent" side="bottom">
              <Link
                href="/add-agent"
                className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-1.5 text-[11px] uppercase tracking-[0.15em] text-gray-300 hover:border-emerald-400/40 hover:text-emerald-300 transition-colors whitespace-nowrap"
              >
                <Plus className="w-3 h-3" />
                Host
              </Link>
            </Tooltip>
          )}
        </div>
      </div>
    </motion.header>
  );
}
