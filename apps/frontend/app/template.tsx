"use client";

// Per-route transition wrapper. Next 14 App Router automatically
// re-mounts `template.tsx` on every navigation, so wrapping the
// children in a `<motion.div>` with `initial → animate` gives every
// route a fade-up entrance without manual key-on-pathname plumbing.

import { motion } from "framer-motion";
import type { ReactNode } from "react";

export default function Template({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      style={{ minHeight: "100vh" }}
    >
      {children}
    </motion.div>
  );
}
