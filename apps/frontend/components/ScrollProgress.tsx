"use client";

// Thin 2px gradient bar pinned to the top of the viewport, scaling its
// width with `scrollYProgress` from Framer Motion. Mounted globally.

import { motion, useScroll, useSpring } from "framer-motion";

export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 110,
    damping: 26,
    mass: 0.4,
  });
  return (
    <motion.div
      aria-hidden
      style={{
        scaleX,
        transformOrigin: "0% 50%",
        background:
          "linear-gradient(90deg, #34d399, #06b6d4, #8b5cf6, #f59e0b)",
      }}
      className="fixed top-0 left-0 right-0 h-[2px] z-[60] pointer-events-none"
    />
  );
}
