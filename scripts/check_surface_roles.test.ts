import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

const ROOT = pathResolver.rootDir();

interface SurfaceRole {
  id: string;
  role_ja: string;
  tagline_ja: string;
  dir: string;
  port: number;
  writes: 'full' | 'scoped' | 'none';
  enabled: boolean;
}

function loadRoles(): SurfaceRole[] {
  return (
    JSON.parse(
      safeReadFile(path.join(ROOT, 'knowledge', 'product', 'governance', 'surface-roles.json'), {
        encoding: 'utf8',
      }) as string
    ) as { roles: SurfaceRole[] }
  ).roles;
}

/** The file each surface renders its identity/tagline from. */
const IDENTITY_SOURCES: Record<string, string> = {
  concierge: 'presence/displays/concierge/src/app/layout.tsx',
  'presence-studio': 'presence/displays/presence-studio/static/index.html',
  'chronos-mirror-v2': 'presence/displays/chronos-mirror-v2/src/app/page.tsx',
  'operator-surface': 'presence/displays/operator-surface/src/app/layout.tsx',
  'computer-surface': 'presence/displays/computer-surface/static/index.html',
};

describe('surface roles contract', () => {
  const roles = loadRoles();

  it('defines exactly the five UI surfaces with unique ports', () => {
    expect(roles.map((role) => role.id).sort()).toEqual([
      'chronos-mirror-v2',
      'computer-surface',
      'concierge',
      'operator-surface',
      'presence-studio',
    ]);
    expect(new Set(roles.map((role) => role.port)).size).toBe(roles.length);
  });

  it('points every enabled role at an existing surface directory', () => {
    for (const role of roles.filter((entry) => entry.enabled)) {
      expect(safeExistsSync(path.join(ROOT, role.dir)), `${role.id}: ${role.dir}`).toBe(true);
    }
  });

  it('shows each enabled surface its own tagline in its identity source', () => {
    for (const role of roles.filter((entry) => entry.enabled)) {
      const source = IDENTITY_SOURCES[role.id];
      expect(source, `identity source registered for ${role.id}`).toBeTruthy();
      const content = safeReadFile(path.join(ROOT, source), { encoding: 'utf8' }) as string;
      expect(content, `${role.id} tagline in ${source}`).toContain(role.tagline_ja);
    }
  });

  it('keeps read-only surfaces read-only', () => {
    const writesById = new Map(roles.map((role) => [role.id, role.writes]));
    expect(writesById.get('operator-surface')).toBe('none');
    expect(writesById.get('computer-surface')).toBe('none');
  });
});
