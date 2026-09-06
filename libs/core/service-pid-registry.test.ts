import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadServicePidRegistryAtPath, parseServicePidRegistry } from './service-pid-registry.js';

describe('service pid registry parser', () => {
  const persistedPath = pathResolver.sharedTmp('service-pid-registry-test.json');

  afterEach(() => {
    safeRmSync(persistedPath, { recursive: true, force: true });
  });

  it('accepts a finite positive pid registry', () => {
    expect(parseServicePidRegistry({ slack: 1234, github: 5678 })).toEqual({
      slack: 1234,
      github: 5678,
    });
  });

  it('rejects malformed persisted process state', () => {
    expect(parseServicePidRegistry(null)).toBeNull();
    expect(parseServicePidRegistry([])).toBeNull();
    expect(parseServicePidRegistry({ slack: 0 })).toBeNull();
    expect(parseServicePidRegistry({ slack: 1.5 })).toBeNull();
    expect(parseServicePidRegistry({ slack: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseServicePidRegistry({ 'bad service': 1234 })).toBeNull();
    expect(parseServicePidRegistry({ slack: 1234, github: '5678' })).toBeNull();
    expect(parseServicePidRegistry(JSON.parse('{"__proto__":{"polluted":true}}'))).toBeNull();
  });

  it('loads schema-valid persisted process state through the catalog', () => {
    safeWriteFile(persistedPath, JSON.stringify({ slack: 1234, 'local.worker': 5678 }));
    expect(loadServicePidRegistryAtPath(persistedPath)).toEqual({
      slack: 1234,
      'local.worker': 5678,
    });
  });

  it('fails closed for a non-regular persisted process state path', () => {
    safeMkdir(persistedPath, { recursive: true });
    expect(loadServicePidRegistryAtPath(persistedPath)).toBeNull();
  });
});
