import vocabularyCatalog from "../../../../../knowledge/public/orchestration/user-facing-vocabulary.json";

export type SupportedLocale = "en" | "ja";

type VocabularyCatalog = {
  default_locale: SupportedLocale;
  domains?: Record<string, Record<string, Record<string, string>>>;
};

const catalog = vocabularyCatalog as VocabularyCatalog;
const speechLocales: Record<SupportedLocale, string> = {
  en: "en-US",
  ja: "ja-JP",
};

export function normalizeChronosLocale(value: unknown): SupportedLocale {
  const normalized = String(value || catalog.default_locale || "en").trim().toLowerCase().replace(/_/g, "-");
  if (normalized.startsWith("ja")) return "ja";
  return "en";
}

export function resolveChronosLocale(): SupportedLocale {
  if (typeof window !== "undefined") {
    return normalizeChronosLocale(window.navigator.language);
  }
  return catalog.default_locale || "en";
}

export function chronosSpeechLocale(locale = resolveChronosLocale()): string {
  return speechLocales[locale] || speechLocales.en;
}

export function selectChronosLocaleText(locale: SupportedLocale, variants: { en: string; ja?: string }): string {
  return variants[locale] || variants[catalog.default_locale] || variants.en;
}

export function uxLabel(key: string, locale = resolveChronosLocale()): string {
  const entry = catalog.domains?.ux?.[key];
  if (!entry) return key;
  return entry[locale] || entry[catalog.default_locale] || key;
}

export function uxText(key: string, fallbackEn: string, locale = resolveChronosLocale()): string {
  const entry = catalog.domains?.ux?.[key];
  if (!entry) return fallbackEn;
  return entry[locale] || entry[catalog.default_locale] || fallbackEn;
}
