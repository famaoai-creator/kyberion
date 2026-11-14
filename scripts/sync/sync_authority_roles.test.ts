import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';

const rootDir = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(
    safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string
  ) as T;
}

describe('sync_authority_roles', () => {
  it('uses the governed authority-role loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync/sync_authority_roles.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadGovernedAuthorityRoleIndex()');
    expect(source).toContain('defineGenerator');
    expect(source).toContain('runSyncAuthorityRoles');
    expect(source).toContain('parseSafeJsonObjectInput');
    expect(source).not.toContain('JSON.parse(content)');
    expect(source).not.toContain('readJson<');
  });

  it('keeps the snapshot aligned with the canonical directory', () => {
    const dir = path.join(rootDir, 'knowledge/product/governance/authority-roles');
    expect(safeExistsSync(dir)).toBe(true);
    const files = safeReaddir(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const snapshot = readJson<{ authority_roles?: Record<string, unknown> }>(
      'knowledge/product/governance/authority-role-index.json'
    );
    const snapshotRoles = snapshot.authority_roles || {};
    const cards = files.map((file) =>
      readJson<{ role?: string; assignable?: boolean; [key: string]: unknown }>(
        `knowledge/product/governance/authority-roles/${file}`
      )
    );
    const assignable = cards.filter((card) => card.assignable !== false);
    expect(Object.keys(snapshotRoles).sort()).toEqual(
      assignable.map((card) => String(card.role)).sort()
    );

    for (const [index, payload] of cards.entries()) {
      expect(payload.role).toBe(files[index]!.replace(/\.json$/i, ''));
      if (payload.assignable === false) {
        expect(snapshotRoles[payload.role!]).toBeUndefined();
        continue;
      }
      expect(snapshotRoles[payload.role!]).toBeDefined();
      const { role, permissions, ...record } = payload;
      expect(record).toEqual(snapshotRoles[payload.role!]);
    }
  });

  it('projects every card permission verbatim into security-policy.json', () => {
    const dir = path.join(rootDir, 'knowledge/product/governance/authority-roles');
    const expected: Record<string, unknown> = {};
    for (const file of safeReaddir(dir).filter((entry) => entry.endsWith('.json'))) {
      const card = readJson<{ role: string; permissions?: unknown }>(
        `knowledge/product/governance/authority-roles/${file}`
      );
      if (card.permissions) expected[card.role] = card.permissions;
    }
    const policy = readJson<{ authority_role_permissions?: Record<string, unknown> }>(
      'knowledge/product/governance/security-policy.json'
    );
    expect(policy.authority_role_permissions).toEqual(expected);
  });
});
