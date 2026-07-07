/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('concierge surface contract', () => {
  it('declares its role tagline in the layout header', () => {
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain('CEO秘書 — 依頼・承認・成果・例外');
    expect(layout).toContain('秘書室');
  });

  it('guards every mutating route with the shared surface mutation guard', () => {
    const mutatingRoutes = [
      'src/app/api/approvals/[id]/route.ts',
      'src/app/api/outcomes/[id]/route.ts',
    ];
    for (const route of mutatingRoutes) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).toContain('requireConciergeMutationAccess');
    }
  });

  it('keeps GET routes free of mutations (summary/theme are read-only)', () => {
    for (const route of ['src/app/api/summary/route.ts', 'src/app/api/theme/route.ts']) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).not.toMatch(/export (async )?function (POST|PUT|DELETE|PATCH)/);
    }
  });
});
