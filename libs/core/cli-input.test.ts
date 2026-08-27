import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readJsonFile } from './cli-input.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';

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
});
