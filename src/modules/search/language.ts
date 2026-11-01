/** Postgres text-search configurations by BCP 47 language; others get `simple`. */
const CONFIGS: Record<string, string> = {
  ar: "arabic", hy: "armenian", eu: "basque", ca: "catalan", da: "danish", nl: "dutch", en: "english",
  et: "estonian", fi: "finnish", fr: "french", de: "german", el: "greek", hi: "hindi", hu: "hungarian",
  id: "indonesian", ga: "irish", it: "italian", lt: "lithuanian", ne: "nepali", nb: "norwegian",
  nn: "norwegian", no: "norwegian", pt: "portuguese", ro: "romanian", ru: "russian", sr: "serbian",
  es: "spanish", sv: "swedish", ta: "tamil", tr: "turkish", yi: "yiddish",
};

export const textSearchConfig = (locale: string): string => CONFIGS[locale.split("-")[0]!.toLowerCase()] ?? "simple";
