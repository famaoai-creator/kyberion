import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeReadFile } from '@agent/core';
import { safeWriteFile } from '@agent/core';
import {
  computeDeferReevaluations,
  readPreviousLedgerState,
  scanDependencyVulnerabilitiesFromInputs,
  type DependencyVulnerabilityFinding,
} from './scan_dependency_vulns.js';

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

function finding(
  overrides: Partial<DependencyVulnerabilityFinding>
): DependencyVulnerabilityFinding {
  return {
    package_name: 'pkg',
    severity: 'moderate',
    current_version: '1.0.0',
    latest_version: '2.0.0',
    reachability: 0,
    decision: 'defer',
    reason: 'test',
    reevaluate_when: 'test',
    ...overrides,
  };
}

describe('defer re-evaluation loop (Task 4)', () => {
  it('flags decision, version, and severity changes on previously deferred findings', () => {
    const previous = {
      findings: new Map([
        ['a', finding({ package_name: 'a' })],
        ['b', finding({ package_name: 'b' })],
        ['c', finding({ package_name: 'c' })],
        ['d', finding({ package_name: 'd', decision: 'scheduled' })],
      ]),
      patched: new Set<string>(),
    };
    const reevaluations = computeDeferReevaluations(previous, [
      finding({ package_name: 'a', decision: 'urgent_approval' }),
      finding({ package_name: 'b', latest_version: '2.1.0' }),
      finding({ package_name: 'c', severity: 'critical' }),
      finding({ package_name: 'd', decision: 'auto_apply' }), // previous not defer → ignored
      finding({ package_name: 'e' }), // no previous state → ignored
    ]);

    expect(reevaluations.map((entry) => [entry.package_name, entry.trigger])).toEqual([
      ['a', 'decision_changed'],
      ['b', 'new_version_available'],
      ['c', 'severity_changed'],
    ]);
  });

  it('derives ledger state from scan snapshots and patch_apply records', () => {
    const dir = pathResolver.sharedTmp(`vuln-ledger-tests/state-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const lines = [
      JSON.stringify({ findings: [finding({ package_name: 'a', latest_version: '1.1.0' })] }),
      JSON.stringify({ findings: [finding({ package_name: 'a', latest_version: '1.2.0' })] }),
      JSON.stringify({ kind: 'patch_apply', package_name: 'x', status: 'patched' }),
      JSON.stringify({ kind: 'patch_apply', package_name: 'y', status: 'patched' }),
      JSON.stringify({ kind: 'patch_apply', package_name: 'y', status: 'rolled_back' }),
      'not json',
    ];
    safeWriteFile(ledgerPath, `${lines.join('\n')}\n`);

    const state = readPreviousLedgerState(ledgerPath);
    expect(state.findings.get('a')?.latest_version).toBe('1.2.0');
    expect([...state.patched]).toEqual(['x']);
  });

  it('reports reevaluations and unresolved counts across two scans', () => {
    const dir = pathResolver.sharedTmp(`vuln-ledger-tests/loop-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    const workspaceRoot = path.join(dir, 'workspace');
    safeMkdir(workspaceRoot, { recursive: true });

    const auditJson = JSON.stringify({
      vulnerabilities: { transitive_pkg: { severity: 'moderate', range: '<2.0.0' } },
    });
    const first = scanDependencyVulnerabilitiesFromInputs({
      auditJson,
      outdatedJson: JSON.stringify({
        transitive_pkg: { current: '1.0.0', latest: '2.0.0' },
      }),
      workspaceRoot,
      ledgerPath,
    });
    expect(first.findings[0]?.decision).toBe('defer');
    expect(first.reevaluations).toEqual([]);
    expect(first.unresolved_summary).toEqual({ open: 0, deferred: 1, patched: 0 });

    const second = scanDependencyVulnerabilitiesFromInputs({
      auditJson,
      outdatedJson: JSON.stringify({
        transitive_pkg: { current: '1.0.0', latest: '2.1.0' },
      }),
      workspaceRoot,
      ledgerPath,
    });
    expect(second.reevaluations).toEqual([
      expect.objectContaining({
        package_name: 'transitive_pkg',
        trigger: 'new_version_available',
      }),
    ]);
  });
});
