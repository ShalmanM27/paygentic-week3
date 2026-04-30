"use client";

// Tiny theme controller. Default: dark (the brand). Light is a
// thoughtful-product signal — not a design system rebuild.
//
// Implementation: toggles the `dark` class on <html>. Most of the
// codebase uses our custom dark-coded palette tokens (ink, panel, etc.)
// so light mode applies a body-level CSS override below.

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "credit-theme";

function readStored(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyDom(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.remove("dark");
    root.classList.add("light");
  } else {
    root.classList.remove("light");
    root.classList.add("dark");
  }
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>("dark");

  // Hydrate from localStorage on mount.
  useEffect(() => {
    const t = readStored();
    setThemeState(t);
    applyDom(t);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyDom(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, toggle, setTheme };
}
