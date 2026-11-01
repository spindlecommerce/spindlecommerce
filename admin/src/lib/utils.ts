import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** "PARTIALLY_FULFILLED" → "Partially fulfilled". */
export const humanize = (value: string | null | undefined) => {
  if (!value) return "";
  const text = value.replace(/[_.]+/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Drop undefined, null and empty strings so the API treats them as "unchanged". */
export const compact = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;

export const localized = (list: readonly { locale: string; value: string }[] | null | undefined, locale?: string) =>
  list?.find((l) => l.locale === locale)?.value ?? list?.[0]?.value ?? "";

export const toLocalizedList = (record: Record<string, string>) =>
  Object.entries(record)
    .filter(([, value]) => value.trim() !== "")
    .map(([locale, value]) => ({ locale, value }));

export const fromLocalizedList = (list: readonly { locale: string; value: string }[] | null | undefined) =>
  Object.fromEntries((list ?? []).map((l) => [l.locale, l.value])) as Record<string, string>;

export const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const downloadText = (filename: string, text: string, type = "text/csv;charset=utf-8") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** RFC 4180 CSV, with a BOM so spreadsheet apps detect UTF-8. */
export const toCsv = (rows: readonly (readonly unknown[])[]) =>
  "﻿" +
  rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cell === null || cell === undefined ? "" : String(cell);
          return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n");
