import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

const ROOT = pathResolver.rootDir();

interface SurfaceRole {
  id: string;
  role_ja: string;
  tagline_ja: string;
  tagline_key?: string;
  dir: string;
  port: number;
  // SO-03: 'orchestrator' is a vocabulary addition (a surface with an active
  // OrchestratorSession + mission-ownership work-item claim may steer a
  // mission's lifecycle, same as the CLI orchestrator). No existing role's
  // value changes here — the vocabulary lands now, roles opt in later.
  writes: 'full' | 'scoped' | 'none' | 'orchestrator';
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
  // chronos declares its identity in the page-config module page.tsx imports
  // from (SURFACE_TAGLINE_KEY), not inline in the page component.
  'chronos-mirror-v2': 'presence/displays/chronos-mirror-v2/src/app/chronos-page-config.ts',
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
      if (role.tagline_key) {
        expect(content, `${role.id} tagline key in ${source}`).toContain(role.tagline_key);
      } else {
        expect(content, `${role.id} tagline in ${source}`).toContain(role.tagline_ja);
      }
    }
  });

  it('keeps read-only surfaces read-only', () => {
    const writesById = new Map(roles.map((role) => [role.id, role.writes]));
    expect(writesById.get('operator-surface')).toBe('none');
    expect(writesById.get('computer-surface')).toBe('none');
  });

  it('SO-03: declares the "orchestrator" writes vocabulary without opting any existing role into it yet', () => {
    // The union type itself proves the vocabulary compiles; this asserts the
    // *data* side of the "vocabulary now, opt-in later" contract — no role's
    // value silently became 'orchestrator' as part of adding the enum member.
    for (const role of roles) {
      expect(role.writes, `${role.id} must not opt into 'orchestrator' yet`).not.toBe(
        'orchestrator'
      );
    }
  });
});
