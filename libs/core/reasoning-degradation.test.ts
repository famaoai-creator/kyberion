import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureIo = vi.hoisted(() => ({
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
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

describe('reasoning-degradation marker (LC-08)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-reasoning-degraded-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
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
});
