import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile, safeReaddir } from '@agent/core';
import * as path from 'node:path';

const rootDir = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(path.join(rootDir, filePath), { encoding: 'utf8' }) as string) as T;
}

describe('sync_authority_roles', () => {
  it('keeps the snapshot aligned with the canonical directory', () => {
    const dir = path.join(rootDir, 'knowledge/public/governance/authority-roles');
    expect(safeExistsSync(dir)).toBe(true);
    const files = safeReaddir(dir).filter((entry) => entry.endsWith('.json')).sort();
    expect(files.length).toBeGreaterThan(0);

    const snapshot = readJson<{ authority_roles?: Record<string, unknown> }>(
      'knowledge/public/governance/authority-role-index.json',
    );
    const snapshotRoles = snapshot.authority_roles || {};
    expect(Object.keys(snapshotRoles).sort()).toEqual(files.map((file) => file.replace(/\.json$/i, '')).sort());

    for (const file of files) {
      const payload = readJson<{ role?: string; [key: string]: unknown }>(
        `knowledge/public/governance/authority-roles/${file}`,
      );
      expect(payload.role).toBe(file.replace(/\.json$/i, ''));
      expect(snapshotRoles[payload.role!]).toBeDefined();
      const { role, ...record } = payload;
      expect(record).toEqual(snapshotRoles[payload.role!]);
    }
  });
});
