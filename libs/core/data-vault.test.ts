import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

let sharedBase: string;

vi.mock('./path-resolver.js', () => ({
  shared: (sub = '') => path.join(sharedBase, sub),
}));

vi.mock('./secure-io.js', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeReadFile: (p: string, opts: any) => actualFs.readFileSync(p, opts),
    safeWriteFile: (p: string, content: string) => actualFs.writeFileSync(p, content),
    safeExistsSync: (p: string) => actualFs.existsSync(p),
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeUnlinkSync: (p: string) => actualFs.unlinkSync(p),
    safeReaddir: (p: string) => actualFs.readdirSync(p),
    safeStat: (p: string) => actualFs.statSync(p),
  };
});

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  fetchWithVaultCache,
  getVaultEntry,
  invalidateVaultEntry,
  listVaultEntries,
} from './data-vault.js';

describe('data-vault', () => {
  beforeEach(() => {
    sharedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(sharedBase, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('fetchWithVaultCache', () => {
    it('calls fetchFn on cache miss and stores result', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ title: 'Test Page', body: 'Hello' });

      const result = await fetchWithVaultCache('confluence', 'page:100', fetchFn, {
        tier: 'confidential',
        projectId: 'test-project',
        ttlMs: 60_000,
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(result.fromCache).toBe(false);
      expect(result.data).toEqual({ title: 'Test Page', body: 'Hello' });
      expect(result.entry.sourceType).toBe('confluence');
      expect(result.entry.tier).toBe('confidential');
      expect(result.entry.projectId).toBe('test-project');
      expect(result.entry.expiresAt).toBeDefined();
    });

    it('returns cached entry on cache hit without calling fetchFn', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ content: 'original' });

      // First fetch — populates cache
      await fetchWithVaultCache('notion', 'doc:abc', fetchFn, {
        projectId: 'proj-a',
        ttlMs: 60_000,
      });

      // Second fetch — should use cache
      const fetchFn2 = vi.fn().mockResolvedValue({ content: 'should not be called' });
      const result = await fetchWithVaultCache('notion', 'doc:abc', fetchFn2, {
        projectId: 'proj-a',
        ttlMs: 60_000,
      });

      expect(fetchFn2).not.toHaveBeenCalled();
      expect(result.fromCache).toBe(true);
      expect(result.data).toEqual({ content: 'original' });
    });

    it('re-fetches after TTL expiry', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ v: 1 });

      // Store with 1ms TTL (immediately expired)
      await fetchWithVaultCache('web', 'url:example', fetchFn, {
        projectId: 'proj-b',
        ttlMs: 1,
      });

      // Wait for TTL to pass
      await new Promise(r => setTimeout(r, 5));

      const fetchFn2 = vi.fn().mockResolvedValue({ v: 2 });
      const result = await fetchWithVaultCache('web', 'url:example', fetchFn2, {
        projectId: 'proj-b',
        ttlMs: 60_000,
      });

      expect(fetchFn2).toHaveBeenCalledOnce();
      expect(result.fromCache).toBe(false);
      expect(result.data).toEqual({ v: 2 });
    });

    it('stores contentHash and tier metadata', async () => {
      const data = { rows: [1, 2, 3] };
      const fetchFn = vi.fn().mockResolvedValue(data);

      const result = await fetchWithVaultCache('gdrive', 'file:xyz', fetchFn, {
        tier: 'personal',
        projectId: '_global',
        ttlMs: 3_600_000,
      });

      expect(result.entry.contentHash).toMatch(/^sha256:/);
      expect(result.entry.tier).toBe('personal');
    });

    it('uses confidential as default tier', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ secret: true });
      const result = await fetchWithVaultCache('slack', 'channel:abc', fetchFn);
      expect(result.entry.tier).toBe('confidential');
    });

    it('stores entries without TTL when ttlMs=0', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ permanent: true });
      const result = await fetchWithVaultCache('custom', 'static-ref', fetchFn, { ttlMs: 0 });
      expect(result.entry.expiresAt).toBeUndefined();
    });
  });

  describe('getVaultEntry', () => {
    it('returns null for absent entries', () => {
      expect(getVaultEntry('confluence', 'nonexistent', 'proj')).toBeNull();
    });

    it('returns stored entry', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ data: 42 });
      await fetchWithVaultCache('github', 'repo:test', fetchFn, {
        projectId: 'proj-c',
        ttlMs: 60_000,
      });

      const entry = getVaultEntry('github', 'repo:test', 'proj-c');
      expect(entry).not.toBeNull();
      expect(entry?.data).toEqual({ data: 42 });
    });

    it('returns null for expired entries', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ x: 1 });
      await fetchWithVaultCache('notion', 'expired-key', fetchFn, {
        projectId: 'proj-d',
        ttlMs: 1,
      });
      await new Promise(r => setTimeout(r, 5));

      const entry = getVaultEntry('notion', 'expired-key', 'proj-d');
      expect(entry).toBeNull();
    });
  });

  describe('invalidateVaultEntry', () => {
    it('deletes an existing entry and returns true', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ v: 'delete-me' });
      await fetchWithVaultCache('web', 'to-delete', fetchFn, {
        projectId: 'proj-e',
        ttlMs: 60_000,
      });

      expect(invalidateVaultEntry('web', 'to-delete', 'proj-e')).toBe(true);
      expect(getVaultEntry('web', 'to-delete', 'proj-e')).toBeNull();
    });

    it('returns false for non-existent entry', () => {
      expect(invalidateVaultEntry('web', 'ghost', 'proj-e')).toBe(false);
    });

    it('forces re-fetch after invalidation', async () => {
      const fetchFn1 = vi.fn().mockResolvedValue({ v: 1 });
      await fetchWithVaultCache('gdrive', 'inv-key', fetchFn1, {
        projectId: 'proj-f',
        ttlMs: 60_000,
      });

      invalidateVaultEntry('gdrive', 'inv-key', 'proj-f');

      const fetchFn2 = vi.fn().mockResolvedValue({ v: 2 });
      const result = await fetchWithVaultCache('gdrive', 'inv-key', fetchFn2, {
        projectId: 'proj-f',
        ttlMs: 60_000,
      });

      expect(fetchFn2).toHaveBeenCalledOnce();
      expect(result.data).toEqual({ v: 2 });
    });
  });

  describe('listVaultEntries', () => {
    it('returns empty array when no entries exist', () => {
      expect(listVaultEntries()).toHaveLength(0);
    });

    it('lists all stored entries', async () => {
      await fetchWithVaultCache('confluence', 'page:1', vi.fn().mockResolvedValue({ a: 1 }), { projectId: 'p1', ttlMs: 60_000 });
      await fetchWithVaultCache('gdrive', 'file:2', vi.fn().mockResolvedValue({ b: 2 }), { projectId: 'p1', ttlMs: 60_000 });

      const entries = listVaultEntries();
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by sourceType', async () => {
      await fetchWithVaultCache('confluence', 'page:10', vi.fn().mockResolvedValue({}), { projectId: 'px', ttlMs: 60_000 });
      await fetchWithVaultCache('notion', 'doc:10', vi.fn().mockResolvedValue({}), { projectId: 'px', ttlMs: 60_000 });

      const confluenceEntries = listVaultEntries({ sourceType: 'confluence', projectId: 'px' });
      expect(confluenceEntries.every(e => e.sourceType === 'confluence')).toBe(true);
    });

    it('filters by projectId', async () => {
      await fetchWithVaultCache('web', 'url:a', vi.fn().mockResolvedValue({}), { projectId: 'proj-list', ttlMs: 60_000 });
      await fetchWithVaultCache('web', 'url:b', vi.fn().mockResolvedValue({}), { projectId: 'other-proj', ttlMs: 60_000 });

      const entries = listVaultEntries({ projectId: 'proj-list' });
      expect(entries.every(e => e.projectId === 'proj-list')).toBe(true);
    });

    it('excludes expired entries by default', async () => {
      await fetchWithVaultCache('slack', 'ch:expired', vi.fn().mockResolvedValue({}), { projectId: 'py', ttlMs: 1 });
      await new Promise(r => setTimeout(r, 5));

      const entries = listVaultEntries({ projectId: 'py' });
      expect(entries.filter(e => e.key === 'ch:expired')).toHaveLength(0);
    });

    it('includes expired entries when includeExpired=true', async () => {
      await fetchWithVaultCache('slack', 'ch:will-expire', vi.fn().mockResolvedValue({}), { projectId: 'pz', ttlMs: 1 });
      await new Promise(r => setTimeout(r, 5));

      const entries = listVaultEntries({ projectId: 'pz', includeExpired: true });
      expect(entries.filter(e => e.key === 'ch:will-expire')).toHaveLength(1);
    });
  });
});
