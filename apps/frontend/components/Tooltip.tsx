"use client";

// Lightweight glass tooltip primitive. Wraps any element and shows a
// dark-glass label on hover or keyboard focus. 200ms fade-in. The
// trigger is wrapped in a relatively-positioned span so the tooltip
// can sit absolutely without affecting page layout.

import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: TooltipSide;
  /** Render delay in ms before the tooltip becomes visible. Helps
   *  avoid noise on quick passes-through. */
  delay?: number;
  className?: string;
}

export function Tooltip({
  label,
  children,
  side = "bottom",
  delay = 250,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<ReturnType<typeof setTimeout> | null>(null);

  function show() {
    if (t) clearTimeout(t);
    setT(setTimeout(() => setOpen(true), delay));
  }
  function hide() {
    if (t) clearTimeout(t);
    setT(null);
    setOpen(false);
  }

  const sideCls: Record<TooltipSide, string> = {
    top: "bottom-full mb-2 left-1/2 -translate-x-1/2",
    bottom: "top-full mt-2 left-1/2 -translate-x-1/2",
    left: "right-full mr-2 top-1/2 -translate-y-1/2",
    right: "left-full ml-2 top-1/2 -translate-y-1/2",
  };

  return (
    <span
      className={`relative inline-flex ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, y: side === "top" ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: side === "top" ? 4 : -4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-white/10 bg-[rgba(7,11,22,0.95)] backdrop-blur-md px-2 py-1 text-[11px] font-mono-tight text-ink shadow-lg shadow-black/40 ${sideCls[side]}`}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
