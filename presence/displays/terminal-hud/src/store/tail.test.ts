import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathResolver } from '@agent/core';
import { ensureDir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { tailJsonl, tailLines } from './tail.js';

const tmpDir = pathResolver.active(`shared/tmp/terminal-hud-tail-test-${process.pid}`);

function writeFixture(name: string, content: string): string {
  ensureDir(tmpDir);
  const filePath = path.join(tmpDir, name);
  safeWriteFile(filePath, content);
  return filePath;
}

afterAll(() => {
  safeRmSync(tmpDir, { recursive: true, force: true });
});

describe('tailLines', () => {
  it('returns [] for a missing file', () => {
    expect(tailLines(path.join(tmpDir, 'missing.jsonl'), 5)).toEqual([]);
  });

  it('returns at most maxLines trailing non-empty lines', () => {
    const filePath = writeFixture('lines.txt', 'a\nb\n\nc\nd\n');
    expect(tailLines(filePath, 2)).toEqual(['c', 'd']);
    expect(tailLines(filePath, 10)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not follow a symlinked tail source', () => {
    const target = writeFixture('target.txt', 'secret\n');
    const link = path.join(tmpDir, 'linked.txt');
    safeSymlinkSync(target, link);
    expect(tailLines(link, 5)).toEqual([]);
  });
});

describe('tailJsonl', () => {
  it('parses trailing JSONL records and skips malformed lines', () => {
    const filePath = writeFixture(
      'records.jsonl',
      `${JSON.stringify({ n: 1 })}\n{broken\n${JSON.stringify({ n: 2 })}\n`
    );
    expect(
      tailJsonl<{ n: number }>(filePath, 10, (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const n = (value as { n?: unknown }).n;
        return typeof n === 'number' ? { n } : null;
      })
    ).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('does not project unvalidated JSON objects', () => {
    const filePath = writeFixture('mixed-records.jsonl', '{"n":"unexpected"}\n{"n":3}\n');
    expect(
      tailJsonl<{ n: number }>(filePath, 10, (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
        const n = (value as { n?: unknown }).n;
        return typeof n === 'number' ? { n } : null;
      })
    ).toEqual([{ n: 3 }]);
  });
});
