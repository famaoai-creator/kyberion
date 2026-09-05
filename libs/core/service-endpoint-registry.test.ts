import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';

describe('service-endpoint-registry', () => {
  const tmpDir = pathResolver.sharedTmp('service-endpoint-registry-tests');

  afterEach(() => {
    delete process.env.KYBERION_SERVICE_ENDPOINTS_PATH;
    delete process.env.KYBERION_SERVICE_ENDPOINTS_DIR;
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid configured snapshot', () => {
    safeMkdir(tmpDir, { recursive: true });
    const snapshotPath = path.join(tmpDir, 'valid.json');
    safeWriteFile(
      snapshotPath,
      JSON.stringify({
        default_pattern: 'https://api.{service_id}.com/v1',
        services: { slack: { base_url: 'https://slack.com/api' } },
      })
    );
    process.env.KYBERION_SERVICE_ENDPOINTS_PATH = snapshotPath;

    expect(loadServiceEndpointsCatalog().services.slack.base_url).toBe('https://slack.com/api');
  });

  it('loads the canonical split directory when entries omit an optional version', () => {
    const catalog = loadServiceEndpointsCatalog();

    expect(catalog.version).toBe('1.0.0');
    expect(Object.keys(catalog.services).length).toBeGreaterThan(0);
  });

  it('fails closed for a schema-invalid configured snapshot', () => {
    safeMkdir(tmpDir, { recursive: true });
    const snapshotPath = path.join(tmpDir, 'invalid.json');
    safeWriteFile(snapshotPath, JSON.stringify({ version: '1.0.0' }));
    process.env.KYBERION_SERVICE_ENDPOINTS_PATH = snapshotPath;

    expect(() => loadServiceEndpointsCatalog()).toThrow(/Invalid catalog service-endpoints/);
  });

  it('rejects a configured snapshot outside the repository', () => {
    process.env.KYBERION_SERVICE_ENDPOINTS_PATH = '/tmp/service-endpoints-external.json';

    expect(() => loadServiceEndpointsCatalog()).toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
