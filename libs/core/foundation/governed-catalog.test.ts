import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const onFallback = vi.fn();
    const instance = defineCatalog<{ version: number }>({
      id: 'governed-catalog-symlink-test',
      path: symlinkPath,
      schema: (value: unknown): value is { version: number } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { version?: unknown }).version === 'number',
      fallback: { version: 0 },
      fallbackOnInvalid: true,
      onFallback,
    });

    expect(() => instance.load()).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => instance.generation()).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => instance.publish({ version: 2 }, null)).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('rejects a catalog directory before attempting to parse it', () => {
    const root = 'active/shared/tmp/governed-catalog-publish-tests';
    const directoryPath = `${root}/catalog-directory.json`;
    safeMkdir(directoryPath, { recursive: true });
    const instance = defineCatalog<{ version: number }>({
      id: 'governed-catalog-directory-test',
      path: directoryPath,
      schema: (value: unknown): value is { version: number } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { version?: unknown }).version === 'number',
      fallback: { version: 0 },
      fallbackOnInvalid: true,
    });

    expect(() => instance.load()).toThrow(
      /Catalog governed-catalog-directory-test must be a regular file/
    );
  });
});

describe('governed catalog fallbacks', () => {
  type Value = { version: number };
  const valid = (value: unknown): value is Value =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as { version?: unknown }).version === 'number';

  it('rejects invalid missing-file fallback before notifying the observer', () => {
    const onFallback = vi.fn();
    const instance = defineCatalog<Value>({
      id: 'missing-fallback',
      path: TEST_PATH,
      schema: valid,
      fallback: { version: 'invalid' } as unknown as Value,
      onFallback,
    });

    expect(() => instance.load()).toThrow(/Invalid catalog missing-fallback/);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it.each(['{invalid JSON', JSON.stringify({ version: 'invalid' })])(
    'does not notify or cache an invalid fallback for invalid contents %s',
    (contents) => {
      safeWriteFile(TEST_PATH, contents);
      let version: unknown = 'invalid fallback';
      const factory = vi.fn(() => ({ version }) as Value);
      const onFallback = vi.fn();
      const instance = defineCatalog<Value>({
        id: 'invalid-file-fallback',
        path: TEST_PATH,
        schema: valid,
        fallback: factory,
        fallbackOnInvalid: true,
        onFallback,
      });

      expect(() => instance.load()).toThrow(/Invalid catalog invalid-file-fallback/);
      expect(onFallback).not.toHaveBeenCalled();
      version = 2;
      const recovered = instance.load();
      expect(recovered).toEqual({ version: 2 });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(onFallback).toHaveBeenCalledExactlyOnceWith(expect.any(Error), recovered);
      version = 3;
      expect(instance.load()).toBe(recovered);
      expect(factory).toHaveBeenCalledTimes(2);
      instance.reset();
      expect(instance.load()).toEqual({ version: 3 });
      expect(factory).toHaveBeenCalledTimes(3);
    }
  );

  it('revalidates missing-file fallback factories without reset after a failure', () => {
    let version: unknown = 'invalid';
    const factory = vi.fn(() => ({ version }) as Value);
    const instance = defineCatalog<Value>({
      id: 'missing-factory-fallback',
      path: TEST_PATH,
      schema: valid,
      fallback: factory,
    });

    expect(() => instance.load()).toThrow(/Invalid catalog missing-factory-fallback/);
    version = 1;
    expect(instance.load()).toEqual({ version: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('validates cloned fallback values and applies the same metadata normalization as files', () => {
    const fallback = { version: 1, $schema: 'catalog-metadata.json' };
    const onFallback = vi.fn();
    const instance = defineCatalog<Value>({
      id: 'cloned-fallback',
      path: TEST_PATH,
      schema: valid,
      fallback,
      onFallback,
    });

    const first = instance.load();
    expect(first).toEqual({ version: 1 });
    expect(first).not.toBe(fallback);
    first.version = 2;
    expect(fallback).toEqual({ version: 1, $schema: 'catalog-metadata.json' });
    expect(instance.load()).toEqual({ version: 1 });
    expect(onFallback).toHaveBeenCalledTimes(2);
  });

  it('retains missing-file errors without fallback and refuses fallback for directories', () => {
    const noFallback = defineCatalog<Value>({ id: 'no-fallback', path: TEST_PATH, schema: valid });
    expect(() => noFallback.load()).toThrow(/Catalog no-fallback is missing/);
    safeMkdir(TEST_PATH, { recursive: true });
    const onFallback = vi.fn();
    const instance = defineCatalog<Value>({
      id: 'directory-fallback',
      path: TEST_PATH,
      schema: valid,
      fallback: { version: 0 },
      fallbackOnInvalid: true,
      onFallback,
    });
    expect(() => instance.load()).toThrow(/must be a regular file/);
    expect(onFallback).not.toHaveBeenCalled();
  });
});
