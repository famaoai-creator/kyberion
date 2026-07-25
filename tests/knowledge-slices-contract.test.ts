import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

describe('Knowledge slices contract (KP-03)', () => {
  it('validates the knowledge slices manifest against its schema', () => {
    const schema = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/schemas/knowledge-slices.schema.json'), {
        encoding: 'utf8',
      }) as string
    );
    const slices = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/governance/knowledge-slices.json'), {
        encoding: 'utf8',
      }) as string
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(slices);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('declares at least one directive per slice and keeps paths under knowledge/', () => {
    const slices = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/governance/knowledge-slices.json'), {
        encoding: 'utf8',
      }) as string
    ) as {
      slices: Array<{ pinned?: string[]; search_roots?: string[]; exclude?: string[] }>;
    };

    expect(slices.slices.length).toBeGreaterThan(0);
    for (const slice of slices.slices) {
      const hasDirective = Boolean(
        (slice.pinned && slice.pinned.length) ||
        (slice.search_roots && slice.search_roots.length) ||
        (slice.exclude && slice.exclude.length)
      );
      expect(hasDirective).toBe(true);
      for (const p of slice.pinned ?? []) expect(p.startsWith('knowledge/')).toBe(true);
      for (const r of slice.search_roots ?? []) expect(r.startsWith('knowledge/')).toBe(true);
      for (const g of slice.exclude ?? []) expect(g.startsWith('knowledge/')).toBe(true);
    }
  });
});
