import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';
import { defineCatalog } from './governed-catalog.js';

const TEST_PATH = 'active/shared/tmp/governed-catalog-publish-tests/catalog.json';

afterEach(() => {
  safeRmSync('active/shared/tmp/governed-catalog-publish-tests', {
    recursive: true,
    force: true,
  });
});

describe('governed catalog publication', () => {
  const catalog = () =>
    defineCatalog<{ version: number }>({
      id: 'governed-catalog-publish-test',
      path: TEST_PATH,
      schema: (value: unknown): value is { version: number } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { version?: unknown }).version === 'number',
    });

  it('publishes against the missing generation and returns a content generation', () => {
    const instance = catalog();

    const generation = instance.publish({ version: 1 }, null);

    expect(generation).toMatch(/^[0-9a-f]{64}$/);
    expect(instance.generation()).toBe(generation);
    expect(instance.load()).toEqual({ version: 1 });
  });

  it('rejects a stale publisher without changing the catalog', () => {
    const instance = catalog();
    const firstGeneration = instance.publish({ version: 1 }, null);

    expect(() => instance.publish({ version: 2 }, 'stale-generation')).toThrow(
      /has changed: expected generation stale-generation/
    );
    expect(instance.generation()).toBe(firstGeneration);
    expect(instance.load()).toEqual({ version: 1 });
  });

  it('validates before writing a new generation', () => {
    const instance = catalog();
    const firstGeneration = instance.publish({ version: 1 }, null);

    expect(() => instance.publish({ version: 'invalid' }, firstGeneration)).toThrow(
      /Invalid catalog governed-catalog-publish-test/
    );
    expect(instance.generation()).toBe(firstGeneration);
  });

  it('rejects symlinked catalog paths for load, generation, and publish', () => {
    const root = 'active/shared/tmp/governed-catalog-publish-tests';
    const externalPath = `${root}/external.json`;
    const symlinkPath = `${root}/catalog-link.json`;
    safeMkdir(root, { recursive: true });
    safeWriteFile(externalPath, JSON.stringify({ version: 1 }));
    safeSymlinkSync(externalPath, symlinkPath);
    const instance = defineCatalog<{ version: number }>({
      id: 'governed-catalog-symlink-test',
      path: symlinkPath,
      schema: (value: unknown): value is { version: number } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { version?: unknown }).version === 'number',
    });

    expect(() => instance.load()).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => instance.generation()).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => instance.publish({ version: 2 }, null)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
