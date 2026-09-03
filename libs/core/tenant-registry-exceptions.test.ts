import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadTenantRegistryExceptionsFile } from './tenant-registry-exceptions.js';

const fixtureRoot = pathResolver.sharedTmp(`tenant-registry-exceptions-${process.pid}`);
const relativePath = 'knowledge/product/governance/tenant-registry-exceptions.json';

describe('tenant registry exceptions loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('returns null when the optional exception file is absent', () => {
    expect(loadTenantRegistryExceptionsFile(fixtureRoot)).toBeNull();
  });

  it('loads valid data and rejects invalid, directory, and symlink entries', () => {
    const filePath = path.join(fixtureRoot, relativePath);
    safeMkdir(path.dirname(filePath), { recursive: true });
    safeWriteFile(
      filePath,
      JSON.stringify({ _meta: 'test', exceptions: [{ slug: 'demo-co', reason: 'fixture' }] })
    );
    expect(loadTenantRegistryExceptionsFile(fixtureRoot)?.exceptions).toEqual([
      { slug: 'demo-co', reason: 'fixture' },
    ]);

    safeWriteFile(filePath, JSON.stringify({ _meta: 'test', exceptions: [{ slug: 'demo-co' }] }));
    expect(() => loadTenantRegistryExceptionsFile(fixtureRoot)).toThrow(
      /Invalid catalog tenant-registry-exceptions/
    );

    safeRmSync(filePath, { force: true });
    safeMkdir(filePath, { recursive: true });
    expect(() => loadTenantRegistryExceptionsFile(fixtureRoot)).toThrow();

    safeRmSync(filePath, { recursive: true, force: true });
    const targetPath = path.join(fixtureRoot, 'target.json');
    safeWriteFile(
      targetPath,
      JSON.stringify({ _meta: 'test', exceptions: [{ slug: 'demo-co', reason: 'fixture' }] })
    );
    safeSymlinkSync(targetPath, filePath);
    expect(() => loadTenantRegistryExceptionsFile(fixtureRoot)).toThrow();
  });
});
