import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readJsonCliInput, readJsonFile } from './cli-input.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';

const fixturePath = pathResolver.sharedTmp('cli-input-reader-test.json');

describe('cli-input JSON reader', () => {
  afterEach(() => {
    safeRmSync(fixturePath, { force: true });
  });

  it('uses the canonical JSON reader and preserves document metadata', () => {
    safeWriteFile(
      fixturePath,
      JSON.stringify({ $schema: 'fixture.schema.json', entries: [{ id: 'one' }] })
    );

    expect(readJsonFile<Record<string, unknown>>(fixturePath)).toEqual({
      $schema: 'fixture.schema.json',
      entries: [{ id: 'one' }],
    });
  });

  it('rejects JSON input paths outside the repository', () => {
    expect(() => readJsonCliInput('/tmp/outside-input.json')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a JSON input reached through a symbolic link', () => {
    const target = pathResolver.sharedTmp('cli-input-reader-target.json');
    const link = pathResolver.sharedTmp('cli-input-reader-link.json');
    safeWriteFile(target, JSON.stringify({ secret: 'outside' }));
    safeRmSync(link, { force: true });
    safeSymlinkSync(target, link);
    try {
      expect(() => readJsonFile(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(link, { force: true });
      safeRmSync(target, { force: true });
    }
  });

  it('rejects dangerous JSON keys before returning CLI input', () => {
    safeWriteFile(fixturePath, '{"__proto__":{"polluted":true}}');
    expect(() => readJsonFile(fixturePath)).toThrow(/dangerous JSON key/);
  });
});
