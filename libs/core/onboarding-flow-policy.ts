import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { normalizeLocale, type SupportedLocale } from './locale-normalize.js';

/**
 * UX-03 Task 3 / I18N-02: operator-facing onboarding strings carry
 * per-locale text. A plain string is treated as English (backward
 * compatibility with pre-localization catalogs).
 *
 * This is keyed by {@link SupportedLocale} (data-driven from the vocabulary
 * catalog's `required_locales`), not a hand-written `{ en, ja }` shape — a
 * hardcoded two-locale object type would need editing at every one of this
 * catalog's entries whenever a locale is added, exactly the failure mode
 * I18N-02 removes for the `'ja' | 'en'` literal unions elsewhere.
 */
export type LocalizedOnboardingText = string | Partial<Record<SupportedLocale, string>>;

export function resolveOnboardingText(value: LocalizedOnboardingText, locale: string): string {
  if (typeof value === 'string') return value;
  const normalized = normalizeLocale(locale);
  if (normalized && value[normalized]) return value[normalized] as string;
  const firstDefined = Object.values(value).find(
    (text): text is string => typeof text === 'string'
  );
  return firstDefined ?? '';
}

export interface OnboardingFlowPolicyCatalog {
  version: string;
  phase_titles: {
    identity: LocalizedOnboardingText;
    services: LocalizedOnboardingText;
    tenants: LocalizedOnboardingText;
    tutorial: LocalizedOnboardingText;
    summary: LocalizedOnboardingText;
  };
  tutorial_plan_title: LocalizedOnboardingText;
  tutorial_next_step_title: LocalizedOnboardingText;
  tutorial_skipped_message: LocalizedOnboardingText;
  tutorial_default_summary: LocalizedOnboardingText;
  complete_message: LocalizedOnboardingText;
}

const CATALOG_PATH = pathResolver.knowledge('product/governance/onboarding-flow-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/onboarding-flow-policy.schema.json');

const FALLBACK_CATALOG: OnboardingFlowPolicyCatalog = {
  version: '1.0.0',
  phase_titles: {
    identity: { en: 'Identity & Purpose', ja: 'アイデンティティと目的' },
    services: { en: 'Infrastructure & Services', ja: 'インフラとサービス' },
    tenants: { en: 'Multi-Tenant Registration', ja: 'マルチテナント登録' },
    tutorial: { en: 'Hands-on Tutorial', ja: 'ハンズオン・チュートリアル' },
    summary: { en: 'Summary', ja: 'サマリ' },
  },
  tutorial_plan_title: {
    en: 'Onboarding Tutorial Plan',
    ja: 'オンボーディング・チュートリアル計画',
  },
  tutorial_next_step_title: { en: 'Suggested next step', ja: '推奨される次のステップ' },
  tutorial_skipped_message: {
    en: 'Tutorial skipped during onboarding.',
    ja: 'オンボーディング中にチュートリアルはスキップされました。',
  },
  tutorial_default_summary: {
    en: 'Demonstrate the initial Kyberion setup with a safe dry-run.',
    ja: '安全な dry-run で Kyberion の初期セットアップを実演します。',
  },
  complete_message: { en: 'Onboarding complete.', ja: 'オンボーディング完了。' },
};

const catalog = defineCatalog<OnboardingFlowPolicyCatalog>({
  id: 'onboarding-flow-policy',
  path: CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: FALLBACK_CATALOG,
});

export function loadOnboardingFlowPolicyCatalog(): OnboardingFlowPolicyCatalog {
  return catalog.load();
}

export function resolveOnboardingFlowPolicy(): OnboardingFlowPolicyCatalog {
  return loadOnboardingFlowPolicyCatalog();
}

export function resetOnboardingFlowPolicyCatalogCache(): void {
  catalog.reset();
}
