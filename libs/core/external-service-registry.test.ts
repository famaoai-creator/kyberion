import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findServiceById,
  listServices,
  registerService,
  resolveProviderUrl,
  writeExternalServiceRegistryAtPath,
} from './external-service-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('external-service-registry', () => {
  const runtimePath = pathResolver.shared('runtime/external-service-registry.json');
  let originalRuntime: string | null = null;

  beforeEach(() => {
    originalRuntime = safeExistsSync(runtimePath)
      ? (safeReadFile(runtimePath, { encoding: 'utf8' }) as string)
      : null;
    safeRmSync(runtimePath, { force: true });
  });

  afterEach(() => {
    safeRmSync(runtimePath, { force: true });
    if (originalRuntime !== null) {
      safeWriteFile(runtimePath, originalRuntime, { mkdir: true });
    }
    originalRuntime = null;
  });

  it('persists and reads a schema-valid runtime service', () => {
    registerService({
      service_id: 'weather-api',
      topic: 'weather',
      url: 'https://example.test/weather',
    });

    expect(findServiceById('weather-api')).toMatchObject({
      service_id: 'weather-api',
      success_count: 0,
      failure_count: 0,
    });
  });

  it('ignores schema-invalid runtime registry data', () => {
    safeWriteFile(
      runtimePath,
      JSON.stringify({
        version: '1.0.0',
        services: [{ service_id: 'broken', topic: 'weather', url: 'not-a-uri' }],
      }),
      { mkdir: true }
    );

    expect(listServices()).toEqual([]);
  });

  it('loads the schema-valid provider catalog for URL resolution', () => {
    expect(resolveProviderUrl('wttr', 'weather', 'Tokyo')).toMatchObject({
      providerId: 'wttr-weather',
      url: 'https://wttr.in/Tokyo?lang=ja',
    });
  });

  it('persists the catalog-normalized runtime registry', () => {
    writeExternalServiceRegistryAtPath(runtimePath, {
      version: '1.0.0',
      services: [],
      $schema: 'https://example.test/schema.json',
    } as unknown as Parameters<typeof writeExternalServiceRegistryAtPath>[1]);

    expect(JSON.parse(String(safeReadFile(runtimePath, { encoding: 'utf8' })))).not.toHaveProperty(
      '$schema'
    );
  });
});
