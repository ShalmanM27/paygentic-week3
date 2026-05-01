"use client";

// Site-wide ambient layer — two slow-drifting radial-gradient blobs,
// a static dot grid, and a soft edge vignette. Pure transform/opacity
// animations, fixed-positioned behind everything (-z-10), pointer-
// events-none. Mounted once in the root layout so every page inherits
// the same identity.

import { motion } from "framer-motion";

export function AmbientBackground() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 pointer-events-none overflow-hidden"
    >
      {/* Drifting accent-green blob */}
      <motion.div
        className="absolute top-[-15%] left-[-10%] w-[60vw] h-[60vw] rounded-full blur-[120px]"
        style={{
          background:
            "radial-gradient(circle, rgba(16,185,129,0.10), transparent 65%)",
          willChange: "transform",
        }}
        animate={{ x: [0, 80, -40, 0], y: [0, 50, -30, 0] }}
        transition={{ duration: 30, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Drifting blue-purple blob */}
      <motion.div
        className="absolute top-[40vh] right-[-15%] w-[55vw] h-[55vw] rounded-full blur-[140px]"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.10), transparent 65%)",
          willChange: "transform",
        }}
        animate={{ x: [0, -70, 40, 0], y: [0, -40, 60, 0] }}
        transition={{ duration: 34, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Static dot grid */}
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.85) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />
      {/* Soft vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.45) 100%)",
        }}
      />
    </div>
  );
}
