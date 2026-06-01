import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  findServiceBootstrapEntriesByUtterance,
  getDefaultServiceIdForSurface,
  loadServiceBootstrapCatalog,
} from './service-bootstrap-catalog.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('service-bootstrap-catalog', () => {
  it('loads the canonical catalog from knowledge', () => {
    const catalog = loadServiceBootstrapCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['github-new-project', 'slack-workspace']),
    );
  });

  it('resolves bootstrap entries from utterances', () => {
    const matches = findServiceBootstrapEntriesByUtterance('新しい Webサービスを作って');
    expect(matches.map((entry) => entry.service_id)).toContain('github');
    expect(matches.map((entry) => entry.binding_id)).toContain('github:default:new-project');
  });

  it('resolves a default surface service from knowledge', () => {
    expect(getDefaultServiceIdForSurface('presence')).toBe('slack');
  });

  it('emits a catalog that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(pathResolver.rootDir(), 'knowledge/public/schemas/service-bootstrap-catalog.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const catalog = loadServiceBootstrapCatalog();
    expect(validate(catalog), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
