import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileSchema, createAjv } from './ajv.js';
import { readJson } from './json.js';
import { safeReaddir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

const GOVERNANCE_DIR = pathResolver.rootResolve('knowledge/product/governance');
const SCHEMA_DIR = pathResolver.rootResolve('knowledge/product/schemas');

interface CatalogWithSchema {
  file: string;
  catalogPath: string;
  schemaPath: string;
  raw: Record<string, unknown>;
}

/**
 * Governance catalogs declare their contract through a root `$schema` pointing
 * at a repo-relative schema file. Absolute URIs (`https://…`) are opaque
 * identifiers rather than resolvable paths, so they are out of scope here.
 */
function isResolvableSchemaRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function collectCatalogsWithSchema(): CatalogWithSchema[] {
  const collected: CatalogWithSchema[] = [];
  for (const file of safeReaddir(GOVERNANCE_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const catalogPath = path.join(GOVERNANCE_DIR, file);
    let raw: unknown;
    try {
      raw = readJson<unknown>(catalogPath);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const ref = record.$schema;
    if (!isResolvableSchemaRef(ref)) continue;
    collected.push({
      file,
      catalogPath,
      schemaPath: path.resolve(path.dirname(catalogPath), ref),
      raw: record,
    });
  }
  return collected;
}

describe('governance catalog schemas accept the root $schema pointer', () => {
  const catalogs = collectCatalogsWithSchema();

  it('finds the governance catalog corpus', () => {
    expect(catalogs.length).toBeGreaterThan(150);
  });

  it.each(catalogs.map((catalog) => [catalog.file, catalog] as const))(
    '%s validates as authored',
    (_file, catalog) => {
      const validate = compileSchema(catalog.schemaPath, createAjv());
      const valid = validate(catalog.raw);
      const errors = (validate.errors || [])
        .map((error) =>
          `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
        )
        .join('; ');
      expect(valid, `${catalog.file}: ${errors}`).toBe(true);
    }
  );

  it('keeps $schema declarable on every strict schema the catalogs point at', () => {
    const offenders: string[] = [];
    for (const catalog of catalogs) {
      const schema = readJson<Record<string, unknown>>(catalog.schemaPath);
      if (schema.additionalProperties !== false) continue;
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (!properties || !properties.$schema) {
        offenders.push(path.relative(SCHEMA_DIR, catalog.schemaPath));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('shared Ajv instances carry the standard format vocabulary', () => {
  const FORMAT_BEARING_SCHEMAS = [
    'calendar-action',
    'knowledge-package',
    'production-evidence-register',
    'contextual-intent-learning',
    'contextual-intent-learning-seed',
    'onboarding-context-binding',
    'onboarding-first-work',
  ];

  it.each(FORMAT_BEARING_SCHEMAS)('compiles %s.schema.json under strict mode', (name) => {
    const schemaPath = path.join(SCHEMA_DIR, `${name}.schema.json`);
    expect(() => compileSchema(schemaPath, createAjv())).not.toThrow();
  });

  it('enforces the registered formats rather than ignoring them', () => {
    const validate = createAjv().compile<{ at: string }>({
      type: 'object',
      additionalProperties: false,
      properties: { at: { type: 'string', format: 'date-time' } },
    });
    expect(validate({ at: '2026-08-27T00:00:00Z' })).toBe(true);
    expect(validate({ at: 'not-a-timestamp' })).toBe(false);
  });
});
