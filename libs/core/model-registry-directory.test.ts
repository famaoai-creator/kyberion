import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import {
  modelRegistryFileName,
  modelRegistrySnapshotFromDirectory,
  readModelRegistryDirectory,
} from './model-registry-directory.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const TEST_ROOT = pathResolver.sharedTmp('model-registry-directory-tests');

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('model-registry-directory', () => {
  it('returns null when the canonical directory is absent', () => {
    expect(readModelRegistryDirectory(path.join(TEST_ROOT, 'missing'))).toBeNull();
  });

  it('uses an injective portable filename encoding', () => {
    expect(modelRegistryFileName('vendor:a')).not.toBe(modelRegistryFileName('vendor--a'));
    expect(modelRegistryFileName('vendor:a')).toMatch(/^model-[0-9a-f]+\.json$/);
    expect(modelRegistryFileName('vendor:a/b')).not.toContain('/');
    expect(modelRegistryFileName('vendor:a\\b')).not.toContain('\\');
  });

  it('rejects an index with unknown fields instead of silently accepting it', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(
      path.join(TEST_ROOT, 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        default_model_id: 'vendor:a',
        model_order: ['vendor:a'],
        unexpected: true,
      })
    );

    expect(() => readModelRegistryDirectory(TEST_ROOT)).toThrow(/Invalid model registry directory/);
  });

  it('rejects an index whose default model is absent from model_order', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(
      path.join(TEST_ROOT, 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        default_model_id: 'vendor:missing',
        model_order: ['vendor:a'],
      })
    );

    expect(() => readModelRegistryDirectory(TEST_ROOT)).toThrow(/Invalid model registry directory/);
  });

  it('projects directory order into the canonical snapshot shape', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    const first = { model_id: 'vendor:first', provider: 'vendor' };
    const second = { model_id: 'vendor:second', provider: 'vendor' };
    safeWriteFile(
      path.join(TEST_ROOT, 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        default_model_id: first.model_id,
        model_order: [first.model_id, second.model_id],
      })
    );
    safeWriteFile(
      path.join(TEST_ROOT, modelRegistryFileName(first.model_id)),
      JSON.stringify(first)
    );
    safeWriteFile(
      path.join(TEST_ROOT, modelRegistryFileName(second.model_id)),
      JSON.stringify(second)
    );

    const directory = readModelRegistryDirectory<typeof first>(TEST_ROOT);
    expect(directory).not.toBeNull();
    expect(modelRegistrySnapshotFromDirectory(directory!)).toEqual({
      version: '1.0.0',
      default_model_id: first.model_id,
      models: [first, second],
    });
  });

  it('rejects a directory item whose filename does not encode model_id', () => {
    safeMkdir(TEST_ROOT, { recursive: true });
    safeWriteFile(
      path.join(TEST_ROOT, 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        default_model_id: 'vendor:a',
        model_order: ['vendor:a'],
      })
    );
    safeWriteFile(path.join(TEST_ROOT, 'vendor--a.json'), JSON.stringify({ model_id: 'vendor:a' }));

    expect(() => readModelRegistryDirectory(TEST_ROOT)).toThrow(/must match model_id/);
  });
});
