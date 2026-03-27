import * as AjvModule from 'ajv';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });

type CatalogCheck = {
  id: string;
  schemaPath: string;
  dataPath: string;
};

const CHECKS: CatalogCheck[] = [
  {
    id: 'service-endpoints',
    schemaPath: 'knowledge/public/schemas/service-endpoints.schema.json',
    dataPath: 'knowledge/public/orchestration/service-endpoints.json',
  },
  {
    id: 'browser-passkey-providers',
    schemaPath: 'knowledge/public/schemas/browser-passkey-providers.schema.json',
    dataPath: 'knowledge/public/orchestration/browser-passkey-providers.json',
  },
  {
    id: 'browser-execution-presets',
    schemaPath: 'knowledge/public/schemas/browser-execution-presets.schema.json',
    dataPath: 'knowledge/public/orchestration/browser-execution-presets.json',
  },
  {
    id: 'android-ui-defaults',
    schemaPath: 'knowledge/public/schemas/android-ui-defaults.schema.json',
    dataPath: 'knowledge/public/orchestration/android-ui-defaults.json',
  },
  {
    id: 'actuator-request-archetypes',
    schemaPath: 'knowledge/public/schemas/actuator-request-archetypes.schema.json',
    dataPath: 'knowledge/public/orchestration/actuator-request-archetypes.json',
  },
  {
    id: 'mobile-app-profile-index',
    schemaPath: 'knowledge/public/schemas/mobile-app-profile-index.schema.json',
    dataPath: 'knowledge/public/orchestration/mobile-app-profiles/index.json',
  },
  {
    id: 'web-app-profile-index',
    schemaPath: 'knowledge/public/schemas/web-app-profile-index.schema.json',
    dataPath: 'knowledge/public/orchestration/web-app-profiles/index.json',
  },
  {
    id: 'user-facing-vocabulary',
    schemaPath: 'knowledge/public/schemas/user-facing-vocabulary.schema.json',
    dataPath: 'knowledge/public/orchestration/user-facing-vocabulary.json',
  },
];

function readJson<T>(relativePath: string): T {
  const fullPath = pathResolver.rootResolve(relativePath);
  return JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string) as T;
}

function validateCatalog(check: CatalogCheck, violations: string[]) {
  const schema = readJson<Record<string, unknown>>(check.schemaPath);
  const data = readJson<Record<string, unknown>>(check.dataPath);
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    for (const error of validate.errors || []) {
      violations.push(`${check.id}: ${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    }
  }

  if (check.id === 'service-endpoints') {
    const typed = data as { services?: Record<string, { base_url?: string }> };
    const services = typed.services || {};
    if (Object.keys(services).length === 0) {
      violations.push('service-endpoints: services must not be empty');
    }
  }

  if (check.id === 'browser-passkey-providers') {
    const typed = data as { default_provider?: string; providers?: Record<string, unknown> };
    if (!typed.providers?.[String(typed.default_provider || '')]) {
      violations.push('browser-passkey-providers: default_provider must exist in providers');
    }
  }

  if (check.id === 'browser-execution-presets') {
    const typed = data as { default_preset?: string; presets?: Record<string, unknown> };
    if (!typed.presets?.[String(typed.default_preset || '')]) {
      violations.push('browser-execution-presets: default_preset must exist in presets');
    }
  }

  if (check.id === 'actuator-request-archetypes') {
    const typed = data as { default_archetype?: string; archetypes?: Array<{ id?: string }> };
    const ids = new Set((typed.archetypes || []).map((item) => String(item.id || '')));
    if (!ids.has(String(typed.default_archetype || ''))) {
      violations.push('actuator-request-archetypes: default_archetype must exist in archetypes');
    }
  }

  if (check.id === 'mobile-app-profile-index' || check.id === 'web-app-profile-index') {
    const typed = data as { profiles?: Array<{ path?: string }> };
    for (const profile of typed.profiles || []) {
      const profilePath = String(profile.path || '');
      if (!profilePath) continue;
      if (!safeExistsSync(pathResolver.rootResolve(profilePath))) {
        violations.push(`${check.id}: referenced profile not found (${profilePath})`);
      }
    }
  }

  if (check.id === 'user-facing-vocabulary') {
    const typed = data as {
      default_locale?: string;
      domains?: Record<string, Record<string, Record<string, string>>>;
    };
    const defaultLocale = String(typed.default_locale || '');
    const domains = typed.domains || {};
    if (!defaultLocale) {
      violations.push('user-facing-vocabulary: default_locale must not be empty');
    }
    for (const [domainName, domainEntries] of Object.entries(domains)) {
      for (const [entryKey, localized] of Object.entries(domainEntries || {})) {
        if (!localized[defaultLocale]) {
          violations.push(`user-facing-vocabulary: ${domainName}.${entryKey} must define the default locale "${defaultLocale}"`);
        }
      }
    }
  }
}

function main() {
  const violations: string[] = [];
  for (const check of CHECKS) {
    validateCatalog(check, violations);
  }

  if (violations.length > 0) {
    console.error('[check:catalogs] violations detected:');
    for (const violation of violations.sort()) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('[check:catalogs] OK');
}

main();
