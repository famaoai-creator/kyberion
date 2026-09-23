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

  it('rejects simulated scenario output as release evidence (ES-04)', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const canonical = loadProductionEvidenceRegister();
    const [first, ...rest] = canonical.items;

    const reportPath = path.join(fixtureRoot, 'scenario-report.json');
    safeWriteFile(
      reportPath,
      JSON.stringify({
        schema_version: 'kyberion-scenario-report.v1',
        executionProfile: 'simulated',
        evidence_class: 'simulated',
      })
    );
    const refPath = path.join(fixtureRoot, 'simulated-ref.json');
    const reportRef = path.relative(pathResolver.rootDir(), reportPath).split(path.sep).join('/');
    safeWriteFile(
      refPath,
      JSON.stringify({ ...canonical, items: [{ ...first, evidence_refs: [reportRef] }, ...rest] })
    );
    expect(() => loadProductionEvidenceRegister(refPath)).toThrow(
      /\[SIMULATED_EVIDENCE_REJECTED\].*scenario-report\.json/
    );

    safeWriteFile(
      reportPath,
      JSON.stringify({
        schema_version: 'kyberion-scenario-report.v1',
        executionProfile: 'provider-qualified',
        evidence_class: 'provider-qualified',
      })
    );
    const okPath = path.join(fixtureRoot, 'qualified-ref.json');
    safeWriteFile(
      okPath,
      JSON.stringify({ ...canonical, items: [{ ...first, evidence_refs: [reportRef] }, ...rest] })
    );
    expect(loadProductionEvidenceRegister(okPath).items[0]?.evidence_refs).toEqual([reportRef]);
  });
});
