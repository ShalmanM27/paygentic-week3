"use client";

// Decorative SVG ornaments for section margins. Pure visual interest,
// no semantic meaning. Three variants, each with a continuous subtle
// animation. Always pointer-events-none + aria-hidden.

import { motion } from "framer-motion";

export type OrnamentVariant = "sun" | "star" | "dots";

interface OrnamentProps {
  variant: OrnamentVariant;
  className?: string;
}

export function Ornament({ variant, className = "" }: OrnamentProps) {
  if (variant === "sun") {
    return (
      <motion.svg
        aria-hidden
        width={48}
        height={48}
        viewBox="0 0 48 48"
        className={`pointer-events-none absolute opacity-30 ${className}`}
        animate={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
        style={{ willChange: "transform" }}
      >
        <g stroke="#34d399" strokeWidth="1.2" strokeLinecap="round" fill="none">
          <circle cx="24" cy="24" r="6" />
          {Array.from({ length: 12 }, (_, i) => {
            // Round to 2 decimals so SSR + client render the exact
            // same string. Without this, JS floating-point produces
            // values like 18.500000000000004 on one runtime and 18.5
            // on the other → React hydration mismatch.
            const a = (i / 12) * Math.PI * 2;
            const r2 = (n: number) => Math.round(n * 100) / 100;
            const x1 = r2(24 + Math.cos(a) * 11);
            const y1 = r2(24 + Math.sin(a) * 11);
            const x2 = r2(24 + Math.cos(a) * 18);
            const y2 = r2(24 + Math.sin(a) * 18);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      </motion.svg>
    );
  }
  if (variant === "star") {
    return (
      <motion.svg
        aria-hidden
        width={32}
        height={32}
        viewBox="0 0 32 32"
        className={`pointer-events-none absolute ${className}`}
        animate={{ scale: [1, 1.15, 1], opacity: [0.4, 0.65, 0.4] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        style={{ willChange: "transform, opacity" }}
      >
        <path
          d="M16 2 L18 14 L30 16 L18 18 L16 30 L14 18 L2 16 L14 14 Z"
          fill="white"
        />
      </motion.svg>
    );
  }
  // dots
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute grid grid-cols-3 gap-2 ${className}`}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <motion.span
          key={i}
          className="block w-1 h-1 rounded-full bg-white"
          animate={{ opacity: [0.15, 0.55, 0.15] }}
          transition={{
            duration: 3,
            repeat: Infinity,
            delay: (i * 0.18) % 3,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}
