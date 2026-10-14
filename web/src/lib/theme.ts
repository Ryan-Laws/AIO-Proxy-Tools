import { useSyncExternalStore } from "react";
import type { Theme } from "@/api/types";

const KEY = "aio-theme";
const listeners = new Set<() => void>();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* 隐私模式等 */
  }
  return "system";
}

let current: Theme = read();

function apply() {
  const dark = current === "dark" || (current === "system" && !!media?.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

media?.addEventListener("change", () => {
  if (current === "system") {
    apply();
    listeners.forEach((l) => l());
  }
});
if (typeof document !== "undefined") apply();

export function getTheme(): Theme {
  return current;
}

export function setTheme(t: Theme) {
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () =>
    current === "dark" || (current === "system" && !!media?.matches) ? "dark" : "light",
  );
}
