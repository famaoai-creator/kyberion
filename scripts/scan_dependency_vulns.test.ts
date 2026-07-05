import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../libs/core/path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../libs/core/secure-io.js';
import {
  scanDependencyVulns,
  writeDependencyVulnLedger,
} from './scan_dependency_vulns.js';

describe('scan_dependency_vulns', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const rootDir = tempRoots.pop();
      if (rootDir) safeRmSync(rootDir, { recursive: true, force: true });
    }
  });

  function makeRootDir(): string {
    const rootDir = path.join(pathResolver.sharedTmp(''), `dependency-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    safeMkdir(rootDir, { recursive: true });
    tempRoots.push(rootDir);
    return rootDir;
  }

  it('classifies direct dependency vulnerabilities and appends ledger entries', () => {
    const rootDir = makeRootDir();
    safeWriteFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'temp-root',
        private: true,
        dependencies: {
          'left-pad': '1.2.0',
        },
      })
    );

    const report = scanDependencyVulns({
      rootDir,
      ledgerPath: path.join(rootDir, 'runtime', 'vuln-ledger.jsonl'),
      writeLedger: true,
      auditJson: JSON.stringify({
        vulnerabilities: {
          'left-pad': {
            severity: 'high',
            via: [{ source: 'CVE-2024-0001', title: 'CVE-2024-0001' }],
            range: '<1.3.0',
            nodes: ['node_modules/left-pad'],
          },
        },
      }),
      outdatedJson: JSON.stringify({
        'left-pad': {
          current: '1.2.0',
          wanted: '1.2.1',
          latest: '2.0.0',
        },
      }),
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      packageName: 'left-pad',
      severity: 'high',
      reachability: 'direct',
      semverJump: 'major',
      rollbackDifficulty: 'hard',
      decision: 'urgent_approval',
      state: 'escalated',
    });
    expect(safeExistsSync(report.ledgerPath)).toBe(true);
    const ledgerLines = String(safeReadFile(report.ledgerPath, { encoding: 'utf8' })).trim().split('\n');
    expect(ledgerLines).toHaveLength(1);
    expect(JSON.parse(ledgerLines[0])).toMatchObject({
      kind: 'dependency_vulnerability',
      package_name: 'left-pad',
      decision: 'urgent_approval',
    });
  });

  it('can write ledger entries explicitly from parsed findings', () => {
    const ledgerPath = path.join(makeRootDir(), 'runtime', 'vuln-ledger.jsonl');
    const written = writeDependencyVulnLedger(
      [
        {
          packageName: 'transitive-lib',
          severity: 'moderate',
          currentVersion: '1.0.0',
          wantedVersion: '1.0.1',
          latestVersion: '1.1.0',
          reachability: 'transitive',
          attackSurface: 'internal',
          semverJump: 'minor',
          testGap: 'thin',
          rollbackDifficulty: 'moderate',
          decision: 'approval',
          state: 'escalated',
          cveIds: ['CVE-2024-0002'],
          advisories: ['CVE-2024-0002'],
          reasons: ['sample'],
          reEvaluateWhen: ['new_patch_available'],
        },
      ],
      { ledgerPath }
    );

    expect(written).toBe(ledgerPath);
    expect(safeExistsSync(ledgerPath)).toBe(true);
  });
});
