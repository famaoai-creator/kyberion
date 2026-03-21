import vocabularyCatalog from "../../../../../knowledge/public/orchestration/user-facing-vocabulary.json";

type SupportedLocale = "en" | "ja";

type VocabularyCatalog = {
  default_locale: SupportedLocale;
  domains?: Record<string, Record<string, Record<string, string>>>;
};

const catalog = vocabularyCatalog as VocabularyCatalog;

export function resolveChronosLocale(): SupportedLocale {
  if (typeof window !== "undefined") {
    const browserLocale = String(window.navigator.language || "").toLowerCase();
    if (browserLocale.startsWith("ja")) return "ja";
  }
  return catalog.default_locale || "en";
}

export function uxLabel(key: string, locale = resolveChronosLocale()): string {
  const entry = catalog.domains?.ux?.[key];
  if (!entry) return key;
  return entry[locale] || entry[catalog.default_locale] || key;
}
