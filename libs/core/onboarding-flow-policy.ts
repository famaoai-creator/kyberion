import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';

/**
 * UX-03 Task 3: operator-facing onboarding strings carry en/ja pairs.
 * A plain string is treated as English (backward compatibility with
 * pre-localization catalogs).
 */
export type LocalizedOnboardingText = string | { en: string; ja?: string };

export function resolveOnboardingText(value: LocalizedOnboardingText, locale: string): string {
  if (typeof value === 'string') return value;
  if (locale === 'ja' && value.ja) return value.ja;
  return value.en;
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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const CATALOG_PATH = pathResolver.knowledge('product/governance/onboarding-flow-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/onboarding-flow-policy.schema.json');

let validateFn: ValidateFunction | null = null;
let cachedCatalog: OnboardingFlowPolicyCatalog | null = null;
let cachedCatalogPath: string | null = null;

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

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateCatalog(value: unknown, label: string): OnboardingFlowPolicyCatalog {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(
      `Invalid onboarding flow policy catalog at ${label}: ${errorsFrom(validate).join('; ')}`
    );
  }
  return value as OnboardingFlowPolicyCatalog;
}

export function loadOnboardingFlowPolicyCatalog(): OnboardingFlowPolicyCatalog {
  if (cachedCatalog && cachedCatalogPath === CATALOG_PATH) return cachedCatalog;
  if (!safeExistsSync(CATALOG_PATH)) {
    cachedCatalog = FALLBACK_CATALOG;
    cachedCatalogPath = CATALOG_PATH;
    return cachedCatalog;
  }
  const parsed = validateCatalog(
    JSON.parse(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) as string),
    CATALOG_PATH
  );
  cachedCatalog = parsed;
  cachedCatalogPath = CATALOG_PATH;
  return parsed;
}

export function resolveOnboardingFlowPolicy(): OnboardingFlowPolicyCatalog {
  return loadOnboardingFlowPolicyCatalog();
}

export function resetOnboardingFlowPolicyCatalogCache(): void {
  cachedCatalog = null;
  cachedCatalogPath = null;
}
