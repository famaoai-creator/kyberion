import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { loadProductionEvidenceRegister } from './production-evidence-register.js';

const fixtureRoot = pathResolver.sharedTmp(`production-evidence-register-${process.pid}`);

describe('production evidence register loader', () => {
  afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

  it('loads a valid register through the schema-bound catalog', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const filePath = path.join(fixtureRoot, 'register.json');
    const canonical = loadProductionEvidenceRegister();
    safeWriteFile(filePath, JSON.stringify(canonical));

    expect(loadProductionEvidenceRegister(filePath)).toMatchObject({
      version: canonical.version,
      items: canonical.items,
    });
  });

  it('rejects schema-invalid, directory, and symlink register paths', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const invalidPath = path.join(fixtureRoot, 'invalid.json');
    const directoryPath = path.join(fixtureRoot, 'directory.json');
    const targetPath = path.join(fixtureRoot, 'target.json');
    const linkedPath = path.join(fixtureRoot, 'linked.json');
    safeWriteFile(invalidPath, JSON.stringify({ version: '1.0.0' }));
    safeMkdir(directoryPath);
    safeWriteFile(targetPath, JSON.stringify(loadProductionEvidenceRegister()));
    safeSymlinkSync(targetPath, linkedPath);

    expect(() => loadProductionEvidenceRegister(invalidPath)).toThrow(
      /Invalid catalog production-evidence-register/
    );
    expect(() => loadProductionEvidenceRegister(directoryPath)).toThrow();
    expect(() => loadProductionEvidenceRegister(linkedPath)).toThrow();
  });
});
