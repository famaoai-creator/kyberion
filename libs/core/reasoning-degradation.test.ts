import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  assertSafeRepositoryPath: (filePath: string) => {
    const root = path.resolve(process.env.KYBERION_ROOT || process.cwd());
    const absolute = path.resolve(filePath);
    const relative = path.relative(root, absolute);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `[RESOURCE_PATH_SCOPE] resource path is outside the repository root: ${filePath}`
      );
    }
    return absolute;
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  safeUnlinkSync: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeUnlink: (filePath: string) => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));

vi.mock('./secure-io.js', () => secureIo);
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: secureIo.loadJson,
    loadJsonIfPresent: secureIo.loadJsonIfPresent,
    appendFile: () => undefined,
    exists: secureIo.safeExistsSync,
    readFile: (filePath: string) => String(secureIo.safeReadFile(filePath)),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: secureIo.safeWriteFile,
  }),
  registerFoundationIo: () => undefined,
}));

describe('reasoning-degradation marker (LC-08)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reasoning-degraded-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpRoot, 'knowledge/product/schemas'), { recursive: true });
    fs.copyFileSync(
      path.resolve(
        process.cwd(),
        'knowledge/product/schemas/reasoning-degraded-marker.schema.json'
      ),
      path.join(tmpRoot, 'knowledge/product/schemas/reasoning-degraded-marker.schema.json')
    );
    process.env.KYBERION_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('round-trips mark → read → clear', async () => {
    const { markReasoningDegraded, readReasoningDegraded, clearReasoningDegraded } =
      await import('./reasoning-degradation.js');

    expect(readReasoningDegraded()).toBeNull();

    markReasoningDegraded('claude-cli', 'no usable reasoning backend could be built');
    const marker = readReasoningDegraded();
    expect(marker).not.toBeNull();
    expect(marker!.mode).toBe('claude-cli');
    expect(marker!.reason).toContain('no usable reasoning backend');
    expect(Date.parse(marker!.at)).not.toBeNaN();

    clearReasoningDegraded();
    expect(readReasoningDegraded()).toBeNull();
  });

  it('treats a corrupt marker file as absent', async () => {
    const { readReasoningDegraded, reasoningDegradedMarkerPath } =
      await import('./reasoning-degradation.js');
    const markerPath = reasoningDegradedMarkerPath();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'not-json');
    expect(readReasoningDegraded()).toBeNull();
  });

  it('rejects unknown fields, dangerous keys, and invalid timestamps', async () => {
    const { parseReasoningDegradedMarker } = await import('./reasoning-degradation.js');
    expect(() =>
      parseReasoningDegradedMarker({ mode: 'claude-cli', reason: 'x', at: 'not-a-date' })
    ).toThrow('valid ISO timestamp');
    expect(() =>
      parseReasoningDegradedMarker({
        mode: 'claude-cli',
        reason: 'x',
        at: '2026-09-02T18:00:00.000Z',
        extra: true,
      })
    ).toThrow('unknown field(s)');
    expect(() =>
      parseReasoningDegradedMarker(
        JSON.parse(
          '{"mode":"claude-cli","reason":"x","at":"2026-09-02T18:00:00.000Z","__proto__":{}}'
        )
      )
    ).toThrow('dangerous JSON key');
  });
});
