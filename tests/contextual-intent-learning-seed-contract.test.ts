import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { compileSchemaFromPath } from '../libs/core/schema-loader.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string,
  ) as unknown;
}

describe('contextual intent learning seed contract', () => {
  it('validates the public seed fixture and keeps the examples safe', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schemaPath = pathResolver.rootResolve('knowledge/product/schemas/contextual-intent-learning-seed.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const seed = readJson('knowledge/product/governance/contextual-intent-learning-seed.json');

    expect(validate(seed), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const typed = seed as { entries?: Array<{ tier?: string; source?: string; utterance?: string }> };
    expect(typed.entries?.length).toBeGreaterThanOrEqual(5);
    for (const entry of typed.entries || []) {
      expect(entry.tier).toBe('public');
      expect(entry.source).toBe('seed');
      expect(entry.utterance).not.toContain('Example株式会社');
    }
  });
});
