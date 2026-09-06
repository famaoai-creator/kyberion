import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import { pathResolver } from '@agent/core';
import * as path from 'node:path';

const rootDir = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(
    safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string
  ) as T;
}

describe('sync_team_roles', () => {
  it('uses the governed team-role loaders', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync_team_roles.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadTeamRoleDirectory()');
    expect(source).toContain('loadTeamRoleSnapshot()');
    expect(source).toContain('defineGenerator');
    expect(source).toContain('runSyncTeamRoles');
    expect(source).toContain('parseSafeJsonObjectInput');
    expect(source).not.toContain('JSON.parse(content)');
    expect(source).not.toContain('readJson<');
  });

  it('keeps the snapshot aligned with the canonical directory', () => {
    const dir = path.join(rootDir, 'knowledge/product/orchestration/team-roles');
    expect(safeExistsSync(dir)).toBe(true);
    const files = safeReaddir(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const snapshot = readJson<{ team_roles?: Record<string, unknown> }>(
      'knowledge/product/orchestration/team-role-index.json'
    );
    const snapshotRoles = snapshot.team_roles || {};
    expect(Object.keys(snapshotRoles).sort()).toEqual(
      files.map((file) => file.replace(/\.json$/i, '')).sort()
    );

    for (const file of files) {
      const payload = readJson<{ role?: string; [key: string]: unknown }>(
        `knowledge/product/orchestration/team-roles/${file}`
      );
      expect(payload.role).toBe(file.replace(/\.json$/i, ''));
      expect(snapshotRoles[payload.role!]).toBeDefined();
      const { role, ...record } = payload;
      expect(record).toEqual(snapshotRoles[payload.role!]);
    }
  });
});
