import path from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  getWorkCoordinationImportCatalogEntryByCommand,
  loadWorkCoordinationImportCatalog,
} from './work-coordination-import-catalog.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('work-coordination-import-catalog', () => {
  it('loads the canonical import catalog from knowledge', () => {
    const catalog = loadWorkCoordinationImportCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.imports.map((entry) => entry.command)).toEqual([
      'import-github-issue-file',
      'import-jira-issue-file',
    ]);
  });

  it('resolves import commands from knowledge', () => {
    expect(getWorkCoordinationImportCatalogEntryByCommand('import-github-issue-file')?.source).toBe('github');
    expect(getWorkCoordinationImportCatalogEntryByCommand('import-jira-issue-file')?.source).toBe('jira');
  });

  it('emits a catalog that satisfies the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = path.join(
      pathResolver.rootDir(),
      'knowledge/product/schemas/work-coordination-import-catalog.schema.json',
    );
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const catalog = loadWorkCoordinationImportCatalog();
    expect(validate(catalog), JSON.stringify(validate.errors || [])).toBe(true);
  });
});
