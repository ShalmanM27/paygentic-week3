import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#e5e5e5",
          dim: "#a3a3a3",
          dimmer: "#737373",
        },
        panel: {
          DEFAULT: "#0a0a0a",
          card: "#141414",
          cardHover: "#1c1c1c",
          border: "#262626",
          borderStrong: "#404040",
        },
        accent: {
          DEFAULT: "#00D9A0",
          dim: "#00b88a",
          soft: "rgba(0, 217, 160, 0.12)",
        },
        warn: {
          DEFAULT: "#fbbf24",
          soft: "rgba(251, 191, 36, 0.12)",
        },
        danger: {
          DEFAULT: "#ef4444",
          soft: "rgba(239, 68, 68, 0.12)",
        },
        info: {
          DEFAULT: "#60a5fa",
          soft: "rgba(96, 165, 250, 0.12)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
