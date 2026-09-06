import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function readServerSource(): string {
  return String(
    safeReadFile(pathResolver.rootResolve('presence/displays/presence-studio/server.ts'), {
      encoding: 'utf8',
    })
  );
}

describe('Presence Studio route parameter boundary', () => {
  it('uses the strict route parameter reader for every dynamic route parameter', () => {
    const source = readServerSource();

    expect(source).not.toMatch(/String\(req\.params\.[^)]+\|\| ''\)\.trim\(\)/u);
    expect(source.match(/readPresenceStudioRouteParam\(req\.params\.[^)]+\)/gu)).toHaveLength(6);
  });
});
