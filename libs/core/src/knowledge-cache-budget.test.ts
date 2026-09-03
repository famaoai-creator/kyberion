import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// KM-02 Task 1.2: ki-*.json caches accumulate as scopes/models change.
// enforceKnowledgeCacheBudget evicts least-recently-used files past the
// KYBERION_KI_CACHE_MAX_MB budget, using the ki-usage.json sidecar.

vi.mock('../path-resolver.js', () => ({
  knowledge: (sub = '') =>
    sub.startsWith('product/schemas/')
      ? `${process.cwd()}/knowledge/${sub}`
      : sub
        ? `/tmp/test-knowledge-base/${sub}`
        : '/tmp/test-knowledge-base',
  pathResolver: {
    knowledge: (sub = '') =>
      sub.startsWith('product/schemas/')
        ? `${process.cwd()}/knowledge/${sub}`
        : sub
          ? `/tmp/test-knowledge-base/${sub}`
          : '/tmp/test-knowledge-base',
    rootDir: () => '/tmp/test-root',
    rootResolve: (sub = '') => (sub ? `/tmp/test-root/${sub}` : '/tmp/test-root'),
    shared: (sub = '') => (sub ? `/tmp/test-shared/${sub}` : '/tmp/test-shared'),
  },
}));

vi.mock('../secure-io.js', () => ({
  safeExistsSync: (p: string) => fs.existsSync(p),
  safeReaddir: (p: string) => fs.readdirSync(p),
  safeLstat: (p: string) => fs.lstatSync(p),
  safeReadFile: (p: string, opts: any) => fs.readFileSync(p, opts?.encoding ?? 'utf8'),
  safeWriteFile: (p: string, data: string) => fs.writeFileSync(p, data),
  safeMkdir: (p: string, opts: any) => fs.mkdirSync(p, opts),
  safeStat: (p: string) => fs.statSync(p),
  safeUnlinkSync: (p: string) => fs.unlinkSync(p),
  assertSafeRepositoryPath: (p: string) => p,
  loadJson: <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T,
  loadJsonIfPresent: <T>(p: string): T | null => {
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      return null;
    }
  },
}));

vi.mock('../foundation/json.js', () => ({
  readJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
}));

vi.mock('../foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    loadJsonIfPresent: (filePath: string) =>
      fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null,
    appendFile: (filePath: string, content: string) => fs.appendFileSync(filePath, content),
    exists: (filePath: string) => fs.existsSync(filePath),
    readFile: (filePath: string) => fs.readFileSync(filePath, 'utf8'),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content),
  }),
}));

import { enforceKnowledgeCacheBudget } from './knowledge-index.js';

const HASHES = ['a'.repeat(16), 'b'.repeat(16), 'c'.repeat(16)];

describe('enforceKnowledgeCacheBudget (KM-02)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-cache-'));
    process.env.KYBERION_KI_CACHE_DIR = dir;
    for (const h of HASHES) {
      fs.writeFileSync(path.join(dir, `ki-${h}.json`), 'x'.repeat(1000));
    }
  });

  afterEach(() => {
    delete process.env.KYBERION_KI_CACHE_DIR;
    delete process.env.KYBERION_KI_CACHE_MAX_MB;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function usagePath() {
    return path.join(dir, 'ki-usage.json');
  }

  it('evicts the least-recently-used file when over budget', () => {
    fs.writeFileSync(
      usagePath(),
      JSON.stringify({
        [HASHES[0]]: '2026-01-01T00:00:00.000Z',
        [HASHES[1]]: '2026-06-01T00:00:00.000Z',
        [HASHES[2]]: '2026-07-01T00:00:00.000Z',
      })
    );
    process.env.KYBERION_KI_CACHE_MAX_MB = String(2100 / (1024 * 1024));

    enforceKnowledgeCacheBudget();

    expect(fs.existsSync(path.join(dir, `ki-${HASHES[0]}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `ki-${HASHES[1]}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `ki-${HASHES[2]}.json`))).toBe(true);
    const usage = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    expect(usage[HASHES[0]]).toBeUndefined();
    expect(usage[HASHES[2]]).toBeDefined();
  });

  it('leaves everything alone when under budget', () => {
    process.env.KYBERION_KI_CACHE_MAX_MB = '10';
    enforceKnowledgeCacheBudget();
    for (const h of HASHES) {
      expect(fs.existsSync(path.join(dir, `ki-${h}.json`))).toBe(true);
    }
  });

  it('falls back to mtime ordering when the usage sidecar is missing', () => {
    const oldest = path.join(dir, `ki-${HASHES[1]}.json`);
    const past = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    fs.utimesSync(oldest, past, past);
    process.env.KYBERION_KI_CACHE_MAX_MB = String(2100 / (1024 * 1024));

    enforceKnowledgeCacheBudget();

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(path.join(dir, `ki-${HASHES[0]}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `ki-${HASHES[2]}.json`))).toBe(true);
  });

  it('never deletes the usage sidecar itself', () => {
    fs.writeFileSync(usagePath(), JSON.stringify({}));
    process.env.KYBERION_KI_CACHE_MAX_MB = String(1 / (1024 * 1024));
    enforceKnowledgeCacheBudget();
    expect(fs.existsSync(usagePath())).toBe(true);
    for (const h of HASHES) {
      expect(fs.existsSync(path.join(dir, `ki-${h}.json`))).toBe(false);
    }
  });

  it('ignores a non-object usage sidecar and falls back to file metadata', () => {
    fs.writeFileSync(usagePath(), '[]');
    process.env.KYBERION_KI_CACHE_MAX_MB = String(2100 / (1024 * 1024));

    expect(() => enforceKnowledgeCacheBudget()).not.toThrow();
  });
});
