import { describe, expect, it } from 'vitest';

import {
  checksumLine,
  parseSha256Sums,
  resolveSafeSourceArchivePaths,
  resolveSourceArchivePaths,
} from './source_archive.js';

describe('source archive supply-chain artifact', () => {
  it('emits and parses the standard SHA256SUMS line', () => {
    const { archivePath } = resolveSourceArchivePaths('active/shared/tmp/example.tar.gz');
    const digest = 'a'.repeat(64);
    const sums = checksumLine(archivePath, digest);

    expect(sums).toBe(`${digest}  example.tar.gz\n`);
    expect(parseSha256Sums(sums, 'example.tar.gz')).toBe(digest);
  });

  it('rejects missing, duplicate, and malformed checksum entries', () => {
    const digest = 'b'.repeat(64);
    expect(() => parseSha256Sums('', 'example.tar.gz')).toThrow(/exactly one entry/);
    expect(() =>
      parseSha256Sums(`${digest}  example.tar.gz\n${digest}  example.tar.gz\n`, 'example.tar.gz')
    ).toThrow(/exactly one entry/);
    expect(() => parseSha256Sums(`${'z'.repeat(64)}  example.tar.gz\n`, 'example.tar.gz')).toThrow(
      /malformed entry/
    );
    expect(() =>
      parseSha256Sums(`${digest}  example.tar.gz\nnot-a-checksum\n`, 'example.tar.gz')
    ).toThrow(/malformed entry/);
  });

  it('uses a sibling SHA256SUMS file for direct archive outputs', () => {
    expect(resolveSourceArchivePaths('active/shared/tmp/release.tar.gz')).toEqual({
      archivePath: 'active/shared/tmp/release.tar.gz',
      checksumsPath: 'active/shared/tmp/SHA256SUMS',
    });
  });

  it('rejects archive output paths outside the repository before writing', () => {
    expect(() => resolveSafeSourceArchivePaths('/tmp/kyberion-source.tar.gz')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });
});
