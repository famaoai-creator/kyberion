import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

describe('Presence Studio route parameter boundary', () => {
  it('uses the strict route parameter reader for every dynamic route parameter', () => {
    const serverSource = readRepoFile('presence/displays/presence-studio/server.ts');
    // FD-05 progress/:id and outcomes/:id/verdict moved into
    // `front-desk-routes.ts` (registered from `server.ts`) purely to keep
    // `server.ts` under the `max-file-lines` gate — the strict-reader
    // requirement now spans both files.
    const frontDeskRoutesSource = readRepoFile(
      'presence/displays/presence-studio/front-desk-routes.ts'
    );
    const combined = `${serverSource}\n${frontDeskRoutesSource}`;

    expect(combined).not.toMatch(/String\(req\.params\.[^)]+\|\| ''\)\.trim\(\)/u);
    expect(combined.match(/readPresenceStudioStringParam\(req\.params\.[^)]+\)/gu)).toHaveLength(8);
    expect(serverSource.match(/readPresenceStudioStringParam\(req\.query\.path\)/gu)).toHaveLength(
      2
    );
    expect(serverSource).toContain('normalizeLocale(readSurfaceStringParam(req.query.locale))');
  });
});
