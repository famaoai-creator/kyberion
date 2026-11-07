import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

describe('Presence Studio route parameter boundary', () => {
  it('uses the strict route parameter reader for every dynamic route parameter', () => {
    const serverSource = readRepoFile('presence/displays/presence-studio/server.ts');
    // Front-desk routes live in `front-desk-routes.ts` (registered from
    // `server.ts`) purely to keep `server.ts` under the `max-file-lines`
    // gate — the strict-reader requirement spans these files. (FD-05's
    // progress/:id and outcomes/:id/verdict left with the 進み具合 page.)
    const frontDeskRoutesSource = readRepoFile(
      'presence/displays/presence-studio/front-desk-routes.ts'
    );
    const approvalInboxRoutesSource = readRepoFile(
      'presence/displays/presence-studio/approval-inbox-routes.ts'
    );
    const combined = `${serverSource}\n${frontDeskRoutesSource}\n${approvalInboxRoutesSource}`;

    expect(combined).not.toMatch(/String\(req\.params\.[^)]+\|\| ''\)\.trim\(\)/u);
    expect(combined.match(/readPresenceStudioStringParam\(req\.params\.[^)]+\)/gu)).toHaveLength(6);
    expect(serverSource.match(/readPresenceStudioStringParam\(req\.query\.path\)/gu)).toHaveLength(
      2
    );
    expect(serverSource).toContain('normalizeLocale(readSurfaceStringParam(req.query.locale))');
  });
});
