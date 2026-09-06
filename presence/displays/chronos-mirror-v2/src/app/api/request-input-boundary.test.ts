import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const PATH_ROUTES = [
  'knowledge-ref/route.ts',
  'runtime-file/route.ts',
  'trace-log/route.ts',
  'mission-asset/route.ts',
  'deliverable-preview/route.ts',
  'traces/route.ts',
] as const;

const SCOPE_ROUTES = [
  'approvals/route.ts',
  'deliverables/route.ts',
  'knowledge/route.ts',
  'tenant-scope/route.ts',
  'workitems/route.ts',
] as const;

describe('Chronos route request input boundary', () => {
  it('keeps path query values as URLSearchParams strings without implicit coercion', () => {
    for (const route of PATH_ROUTES) {
      const source = String(
        safeReadFile(
          pathResolver.rootResolve(`presence/displays/chronos-mirror-v2/src/app/api/${route}`),
          { encoding: 'utf8' }
        )
      );
      expect(source).toContain('readChronosStringParam(');
      expect(source).not.toContain("String(req.nextUrl.searchParams.get('path') || '')");
    }
  });

  it('normalizes scope and listing query values before authorization or projection', () => {
    for (const route of SCOPE_ROUTES) {
      const source = String(
        safeReadFile(
          pathResolver.rootResolve(`presence/displays/chronos-mirror-v2/src/app/api/${route}`),
          { encoding: 'utf8' }
        )
      );
      expect(source).toContain('readChronos');
      expect(source).not.toMatch(
        /searchParams\.get\('(?:tenant|organization_id|project_id)'\) \|\|/
      );
    }
  });
});
