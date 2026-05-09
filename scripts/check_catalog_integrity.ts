import * as AjvModule from 'ajv';
import * as path from 'node:path';
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

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
  {
    id: 'specialist-catalog',
    schemaPath: 'knowledge/public/schemas/specialist-catalog.schema.json',
    dataPath: 'knowledge/public/orchestration/specialist-catalog.json',
  },
];

function readJson<T>(relativePath: string): T {
  const fullPath = pathResolver.rootResolve(relativePath);
  return readJsonFile(fullPath);
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
    const typed = data as { default_pattern?: string; services?: Record<string, { base_url?: string }> };
    const services = typed.services || {};
    if (Object.keys(services).length === 0) {
      violations.push('service-endpoints: services must not be empty');
    }

    const directory = pathResolver.rootResolve('knowledge/public/orchestration/service-endpoints');
    if (!safeExistsSync(directory)) {
      violations.push('service-endpoints: canonical directory is missing');
      return;
    }

    const fileNames = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
    if (fileNames.length === 0) {
      violations.push('service-endpoints: canonical directory is empty');
      return;
    }

    const directoryServiceIds: string[] = [];
    for (const fileName of fileNames) {
      const filePath = pathResolver.rootResolve(path.join(directory, fileName));
      const payload = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { default_pattern?: string; services?: Record<string, unknown> };
      const payloadValidate = ajv.compile(schema);
      if (!payloadValidate(payload)) {
        for (const error of payloadValidate.errors || []) {
          violations.push(`service-endpoints: ${fileName}${error.instancePath || '/'} ${error.message || 'schema violation'}`);
        }
      }
      const payloadServices = payload.services || {};
      const payloadServiceIds = Object.keys(payloadServices);
      if (payloadServiceIds.length !== 1) {
        violations.push(`service-endpoints: ${fileName} must contain exactly one service`);
        continue;
      }
      const serviceId = payloadServiceIds[0];
      if (fileName.replace(/\.json$/i, '') !== serviceId) {
        violations.push(`service-endpoints: ${fileName} must match service id ${serviceId}`);
      }
      if (payload.default_pattern !== typed.default_pattern) {
        violations.push(`service-endpoints: ${fileName} default_pattern must match the snapshot`);
      }
      directoryServiceIds.push(serviceId);
    }

    const snapshotServiceIds = Object.keys(services).sort();
    if (directoryServiceIds.sort().join(',') !== snapshotServiceIds.join(',')) {
      violations.push('service-endpoints: directory services must match snapshot services');
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

  if (check.id === 'specialist-catalog') {
    const typed = data as { version?: string; specialists?: Record<string, unknown> };
    const specialists = typed.specialists || {};
    if (Object.keys(specialists).length === 0) {
      violations.push('specialist-catalog: specialists must not be empty');
    }

    const directory = pathResolver.rootResolve('knowledge/public/orchestration/specialists');
    if (!safeExistsSync(directory)) {
      violations.push('specialist-catalog: canonical directory is missing');
      return;
    }

    const fileNames = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
    if (fileNames.length === 0) {
      violations.push('specialist-catalog: canonical directory is empty');
      return;
    }

    const directoryIds: string[] = [];
    for (const fileName of fileNames) {
      const filePath = pathResolver.rootResolve(path.join(directory, fileName));
      const payload = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { version?: string; specialists?: Record<string, unknown> };
      const payloadValidate = ajv.compile(schema);
      if (!payloadValidate(payload)) {
        for (const error of payloadValidate.errors || []) {
          violations.push(`specialist-catalog: ${fileName}${error.instancePath || '/'} ${error.message || 'schema violation'}`);
        }
      }
      const payloadSpecialists = payload.specialists || {};
      const specialistIds = Object.keys(payloadSpecialists);
      if (specialistIds.length !== 1) {
        violations.push(`specialist-catalog: ${fileName} must contain exactly one specialist`);
        continue;
      }
      const specialistId = specialistIds[0];
      if (fileName.replace(/\.json$/i, '') !== specialistId) {
        violations.push(`specialist-catalog: ${fileName} must match specialist id ${specialistId}`);
      }
      if (payload.version !== typed.version) {
        violations.push(`specialist-catalog: ${fileName} version must match the snapshot`);
      }
      directoryIds.push(specialistId);
    }

    if (directoryIds.sort().join(',') !== Object.keys(specialists).sort().join(',')) {
      violations.push('specialist-catalog: directory specialists must match snapshot specialists');
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
