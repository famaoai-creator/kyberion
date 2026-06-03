import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { getServiceAuthorities, loadServiceAuthorityMap } from './service-authority-map.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('service-authority-map', () => {
  it('loads the canonical map from knowledge', () => {
    const map = loadServiceAuthorityMap();
    expect(map.version).toBe('1.0.0');
    expect(map.services.map((entry) => entry.service_id)).toEqual(['github']);
  });

  it('resolves authorities from knowledge', () => {
    expect(getServiceAuthorities('github')).toEqual(['GIT_WRITE', 'NETWORK_FETCH']);
  });

  it('emits a map that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/product/schemas/service-authority-map.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const map = loadServiceAuthorityMap();
    expect(validate(map), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
