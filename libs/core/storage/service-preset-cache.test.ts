import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let rootBase: string;

vi.mock('../path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../path-resolver.js')>('../path-resolver.js');
  return {
    ...actual,
    rootDir: () => rootBase,
    knowledge: (sub = '') => path.join(process.cwd(), 'knowledge', sub),
  };
});

vi.mock('../secure-io.js', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeReadFile: (p: string, opts: any) => actualFs.readFileSync(p, opts),
    safeWriteFile: (p: string, content: string) => actualFs.writeFileSync(p, content),
    assertSafeRepositoryPath: (p: string) => p,
    safeExistsSync: (p: string) => actualFs.existsSync(p),
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeUnlinkSync: (p: string) => actualFs.unlinkSync(p),
    safeReaddir: (p: string) => actualFs.readdirSync(p),
    safeStat: (p: string) => actualFs.statSync(p),
    // Entries are read through a governed catalog, which lstats the path first.
    safeLstat: (p: string) => actualFs.lstatSync(p),
  };
});

vi.mock('../core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  fetchWithServicePresetCache,
  getServicePresetCacheEntry,
  invalidateServicePresetCacheEntry,
  servicePresetCachePartitionRoot,
  servicePresetCacheProjectRoot,
} from './service-preset-cache.js';
import { registerFoundationIo } from '../foundation/io.js';

function filesUnder(repoRelative: string): string[] {
  const dir = path.join(rootBase, repoRelative);
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${repoRelative}/${name.split(path.sep).join('/')}`);
}

const TENANT_A = { tier: 'confidential' as const, tenant: 'tenant-a', projectId: 'proj-a' };

describe('service-preset cache (cache floor)', () => {
  beforeEach(() => {
    rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-service-preset-cache-'));
    registerFoundationIo({
      loadJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
      loadJsonIfPresent: <T>(filePath: string) =>
        fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as T) : null,
      appendFile: (filePath, content) => fs.appendFileSync(filePath, content),
      exists: (filePath) => fs.existsSync(filePath),
      readFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
      stat: (filePath) => fs.statSync(filePath),
      writeFile: (filePath, content) => fs.writeFileSync(filePath, content),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(rootBase, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('lands a tenant entry under cache/<tier>/<tenant>/service-preset/project/<id>/', async () => {
    const result = await fetchWithServicePresetCache('confluence', 'read:abc', () => ({ v: 1 }), {
      scope: TENANT_A,
      ttlMs: 60_000,
    });

    expect(result.fromCache).toBe(false);
    expect(result.entry).toMatchObject({
      tier: 'confidential',
      tenant: 'tenant-a',
      projectId: 'proj-a',
    });
    expect(servicePresetCacheProjectRoot('confidential', 'tenant-a', 'proj-a')).toBe(
      'active/shared/cache/confidential/tenant-a/service-preset/project/proj-a'
    );
    expect(
      filesUnder('active/shared/cache/confidential/tenant-a/service-preset/project/proj-a')
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(rootBase, 'active/shared/data-vault'))).toBe(false);
  });

  it('lands an untenanted entry without project under cache/<tier>/shared/service-preset/global/', async () => {
    await fetchWithServicePresetCache('web', 'read:x', () => ({ v: 1 }), {
      scope: { tier: 'public' },
    });
    expect(servicePresetCachePartitionRoot('public')).toBe(
      'active/shared/cache/public/shared/service-preset'
    );
    expect(filesUnder('active/shared/cache/public/shared/service-preset/global')).toHaveLength(1);
  });

  it('serves a hit only inside the same tier, tenant and project partition', async () => {
    await fetchWithServicePresetCache('notion', 'read:doc', () => ({ owner: 'a' }), {
      scope: TENANT_A,
      ttlMs: 60_000,
    });

    const sameLoader = vi.fn(() => ({ owner: 'again' }));
    const hit = await fetchWithServicePresetCache('notion', 'read:doc', sameLoader, {
      scope: TENANT_A,
      ttlMs: 60_000,
    });
    expect(hit).toMatchObject({ fromCache: true, data: { owner: 'a' } });
    expect(sameLoader).not.toHaveBeenCalled();

    for (const other of [
      { ...TENANT_A, tenant: 'tenant-b' },
      { ...TENANT_A, tier: 'public' as const },
      { ...TENANT_A, projectId: 'proj-b' },
      { tier: 'confidential' as const },
    ]) {
      const loader = vi.fn(() => ({ owner: 'other' }));
      const miss = await fetchWithServicePresetCache('notion', 'read:doc', loader, {
        scope: other,
        ttlMs: 60_000,
      });
      expect(miss.fromCache).toBe(false);
      expect(loader).toHaveBeenCalledOnce();
    }
    // Every scope got its own file; tenant A's entry was never replaced.
    expect(getServicePresetCacheEntry('notion', 'read:doc', TENANT_A)?.data).toEqual({
      owner: 'a',
    });
  });

  it('never serves an entry copied into another tenant partition', async () => {
    await fetchWithServicePresetCache('notion', 'read:doc', () => ({ owner: 'a' }), {
      scope: TENANT_A,
      ttlMs: 60_000,
    });
    const [source] = filesUnder(
      servicePresetCacheProjectRoot('confidential', 'tenant-a', 'proj-a')
    );
    const target = source!.replace('/tenant-a/', '/tenant-b/');
    fs.mkdirSync(path.dirname(path.join(rootBase, target)), { recursive: true });
    fs.copyFileSync(path.join(rootBase, source!), path.join(rootBase, target));

    const loader = vi.fn(() => ({ owner: 'b' }));
    const result = await fetchWithServicePresetCache('notion', 'read:doc', loader, {
      scope: { ...TENANT_A, tenant: 'tenant-b' },
      ttlMs: 60_000,
    });
    expect(result).toMatchObject({ fromCache: false, data: { owner: 'b' } });
  });

  it('treats an expired entry as a miss and rewrites it', async () => {
    await fetchWithServicePresetCache('web', 'read:url', () => ({ v: 1 }), {
      scope: TENANT_A,
      ttlMs: 1,
    });
    vi.setSystemTime(new Date('2026-11-23T00:00:00.010Z'));
    expect(getServicePresetCacheEntry('web', 'read:url', TENANT_A)).toBeNull();

    const result = await fetchWithServicePresetCache('web', 'read:url', () => ({ v: 2 }), {
      scope: TENANT_A,
      ttlMs: 60_000,
    });
    expect(result).toMatchObject({ fromCache: false, data: { v: 2 } });
    expect(getServicePresetCacheEntry('web', 'read:url', TENANT_A)?.data).toEqual({ v: 2 });
  });

  it('fails closed on a tampered entry', async () => {
    await fetchWithServicePresetCache('notion', 'read:t', () => ({ value: 1 }), {
      scope: TENANT_A,
      ttlMs: 60_000,
    });
    const [file] = filesUnder(servicePresetCacheProjectRoot('confidential', 'tenant-a', 'proj-a'));
    const filePath = path.join(rootBase, file!);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    persisted.data = { value: 'tampered' };
    fs.writeFileSync(filePath, JSON.stringify(persisted));

    expect(getServicePresetCacheEntry('notion', 'read:t', TENANT_A)).toBeNull();
  });

  it('invalidates an entry and stores no expiresAt when ttlMs is 0', async () => {
    const stored = await fetchWithServicePresetCache('gdrive', 'read:f', () => ({ v: 1 }), {
      scope: TENANT_A,
      ttlMs: 0,
    });
    expect(stored.entry.expiresAt).toBeUndefined();
    expect(invalidateServicePresetCacheEntry('gdrive', 'read:f', TENANT_A)).toBe(true);
    expect(invalidateServicePresetCacheEntry('gdrive', 'read:f', TENANT_A)).toBe(false);
    expect(getServicePresetCacheEntry('gdrive', 'read:f', TENANT_A)).toBeNull();
  });

  it('rejects a non-slug tenant, a path-like project id and an unknown tier', async () => {
    const loader = vi.fn(() => ({}));
    await expect(
      fetchWithServicePresetCache('web', 'k', loader, {
        scope: { tier: 'confidential', tenant: '../x' },
      })
    ).rejects.toThrow(/STORAGE_LAYOUT_TENANT_INVALID/);
    await expect(
      fetchWithServicePresetCache('web', 'k', loader, {
        scope: { tier: 'confidential', projectId: '..' },
      })
    ).rejects.toThrow(/STORAGE_LAYOUT_SEGMENT_INVALID/);
    await expect(
      fetchWithServicePresetCache('web', 'k', loader, {
        scope: { tier: 'confidential', projectId: 'proj-a/nested' },
      })
    ).rejects.toThrow(/SERVICE_PRESET_CACHE_PROJECT_INVALID/);
    await expect(
      fetchWithServicePresetCache('web', 'k', loader, { scope: { tier: 'secret' as never } })
    ).rejects.toThrow(/SERVICE_PRESET_CACHE_TIER_INVALID/);
    expect(loader).not.toHaveBeenCalled();
  });
});
