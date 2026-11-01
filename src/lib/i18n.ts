/** Text keyed by BCP 47 locale, e.g. `{ "en-US": "Blue", "de-DE": "Blau" }`. */
export type LocalizedText = Record<string, string>;

/** Exact locale, then its language (`de-DE` → `de`), then the fallback, then any value. */
export const pickLocalized = (text: LocalizedText | null | undefined, locale: string, fallbackLocale?: string): string | null => {
  if (!text) return null;
  const language = locale.split("-")[0]!;
  const candidates = [locale, language, fallbackLocale, fallbackLocale?.split("-")[0]];
  for (const candidate of candidates) {
    if (candidate && text[candidate] !== undefined) return text[candidate]!;
  }
  for (const [key, value] of Object.entries(text)) if (key.split("-")[0] === language) return value;
  return Object.values(text)[0] ?? null;
};

export const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
