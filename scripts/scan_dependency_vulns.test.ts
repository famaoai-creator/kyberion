import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeReadFile } from '@agent/core';
import { safeWriteFile } from '@agent/core';
import { scanDependencyVulnerabilitiesFromInputs } from './scan_dependency_vulns.js';

describe('scan_dependency_vulns', () => {
  const ledgerPath = pathResolver.sharedTmp('vuln-ledger-tests/vuln-ledger.jsonl');

  afterEach(() => {
    // temp files are under sharedTmp and can remain; no env state to reset.
  });

  it('parses audit/outdated inputs and appends a ledger entry', () => {
    safeMkdir(pathResolver.sharedTmp('vuln-ledger-tests'), { recursive: true });

    const result = scanDependencyVulnerabilitiesFromInputs({
      auditJson: JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: 'high',
            nodes: ['packages/app/package.json'],
            effects: ['app'],
            range: '<4.17.21',
          },
        },
      }),
      outdatedJson: JSON.stringify({
        lodash: { current: '4.17.20', latest: '4.17.21', wanted: '4.17.21' },
      }),
      workspaceRoot: pathResolver.rootDir(),
      ledgerPath,
    });

    expect(result.scanned_packages).toBe(1);
    expect(result.findings[0]?.package_name).toBe('lodash');
    expect(result.findings[0]?.reachability).toBeGreaterThanOrEqual(0);
    const ledger = safeReadFile(ledgerPath, { encoding: 'utf8' }) as string;
    expect(ledger).toContain('"lodash"');
  });

  it('only considers declared workspace package roots when inferring reachability', () => {
    const workspaceRoot = pathResolver.sharedTmp('vuln-ledger-tests/workspace-root');
    safeMkdir(path.join(workspaceRoot, 'libs', 'core'), { recursive: true });
    safeMkdir(path.join(workspaceRoot, 'active', 'missions', 'confidential', 'sbiss', 'demo'), {
      recursive: true,
    });
    safeWriteFile(
      path.join(workspaceRoot, 'libs', 'core', 'package.json'),
      JSON.stringify(
        {
          name: '@kyberion/core-test',
          dependencies: {
            safe_dep: '^1.0.0',
          },
        },
        null,
        2
      )
    );
    safeWriteFile(
      path.join(
        workspaceRoot,
        'active',
        'missions',
        'confidential',
        'sbiss',
        'demo',
        'package.json'
      ),
      JSON.stringify(
        {
          name: 'untrusted-runtime',
          dependencies: {
            evil_dep: '^9.9.9',
          },
        },
        null,
        2
      )
    );

    const result = scanDependencyVulnerabilitiesFromInputs({
      auditJson: JSON.stringify({
        vulnerabilities: {
          evil_dep: {
            severity: 'high',
            range: '<9.9.9',
          },
        },
      }),
      outdatedJson: JSON.stringify({
        evil_dep: { current: '9.9.8', latest: '9.9.9', wanted: '9.9.9' },
      }),
      workspaceRoot,
      ledgerPath,
    });

    expect(result.findings[0]?.package_name).toBe('evil_dep');
    expect(result.findings[0]?.reachability).toBe(0);
  });
});
