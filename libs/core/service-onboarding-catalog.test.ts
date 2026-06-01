import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { getServiceOnboardingCatalogEntry, loadServiceOnboardingCatalog } from './service-onboarding-catalog.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('service-onboarding-catalog', () => {
  it('loads the canonical onboarding catalog from knowledge', () => {
    const catalog = loadServiceOnboardingCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.services.map((entry) => entry.service_id)).toEqual(['comfyui', 'whisper', 'tts', 'meeting']);
  });

  it('exposes typed entries by service id', () => {
    expect(getServiceOnboardingCatalogEntry('whisper')?.prompt_kind).toBe('whisper');
    expect(getServiceOnboardingCatalogEntry('meeting')?.prompt_kind).toBe('generic');
  });

  it('emits a catalog that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/service-onboarding-catalog.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const catalog = loadServiceOnboardingCatalog();
    expect(validate(catalog), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
