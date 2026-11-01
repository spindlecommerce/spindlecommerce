import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "ecom-admin-theme";
const listeners = new Set<() => void>();

const read = (): Theme => {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
};

const media = typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

export const applyTheme = (theme: Theme = read()) => {
  const dark = theme === "dark" || (theme === "system" && !!media?.matches);
  document.documentElement.classList.toggle("dark", dark);
};

export const setTheme = (theme: Theme) => {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  applyTheme(theme);
  for (const listener of listeners) listener();
};

media?.addEventListener("change", () => applyTheme());

export const useTheme = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => "system" as Theme,
  );
