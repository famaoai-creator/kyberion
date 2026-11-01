import { describe, expect, it } from 'vitest';
import { rootDir } from './path-resolver.js';
import { safeExecResult, safeReadFile } from './secure-io.js';
import { ensureDefaultOpPreflight } from './pipeline/op-preflight-defaults.js';
import { listOpPreflightListeners, resetOpPreflight } from './pipeline/op-preflight.js';

/**
 * SC-09: scope-governance invariants — the convergence contract that keeps
 * the three scope systems from drifting back into parallel mechanisms.
 */
describe('scope governance invariants', () => {
  it('(a) mintScopeEnvelope is only invoked at dispatch boundaries', () => {
    const result = safeExecResult(
      'git',
      ['grep', '-n', 'mintScopeEnvelope(', '--', 'libs/', 'scripts/', 'apps/', 'presence/'],
      { cwd: rootDir() }
    );
    const offenders = result.stdout
      .split('\n')
      .filter(Boolean)
      .filter(
        (line) =>
          !line.includes('scope-envelope.ts:') &&
          !line.includes('.test.ts:') &&
          // Dispatch boundaries stamp the envelope — the only legitimate sites.
          !line.includes('coordinated-agent-execution-port.ts:') &&
          // Protected library-run continuation is a dispatch boundary: mint
          // from the immutable original scope snapshot, never approval input
          // or the resumed process environment. Exercised by the real library
          // approval continuation integration (including changed ambient task).
          !line.startsWith('scripts/pipeline-execution-part-results.ts:') &&
          // The diagnostic CLI is a dispatch boundary: it validates an active
          // tenant mission and its organization/project chain, then creates a
          // real WorkItem claimed through coordinated dispatch. Mission/link
          // and nested-envelope refusal are exercised by its probe tests.
          !line.startsWith('scripts/reasoning_credential_probe.ts:') &&
          // Approval-driven resume is the same boundary in a child process: it
          // mints from the journal's original execution authority with an empty
          // env, never from the approver's process.
          !line.startsWith('libs/core/pipeline/pipeline-approval-resume.ts:')
      );
    expect(offenders).toEqual([]);
  });

  it('(c) the governance stage order is fixed', () => {
    resetOpPreflight();
    try {
      ensureDefaultOpPreflight();
      const ordered = listOpPreflightListeners().map((listener) => listener.id);
      expect(ordered).toEqual([
        'core:scope',
        'core:effect',
        'core:introduction',
        'core:taint',
        'core:provenance-egress',
        'core:adf-guardrails',
        'core:provider-egress',
      ]);
    } finally {
      resetOpPreflight();
    }
  });

  it('(d) the shared module is the only control-plane construction site', () => {
    const result = safeExecResult(
      'git',
      ['grep', '-n', 'new CloudflareOsControlPlane(', '--', '*.ts'],
      { cwd: rootDir() }
    );
    const offenders = result.stdout
      .split('\n')
      .filter(Boolean)
      .filter(
        (line) =>
          !line.includes('cloudflare-os-shared.ts:') &&
          !line.includes('.test.ts:') &&
          !line.startsWith('.worktrees/') &&
          !line.startsWith('.codex/')
      );
    expect(offenders).toEqual([]);
  });

  it('(b) governed records carry tenant only through declared fields', () => {
    // tenantSlug may live only on the types that are the scope identity
    // surface: held context/summary, observations (+aggregates),
    // declassification grants, the journal collection shape, the facade
    // scope, and the surface visibility item. A new field anywhere else
    // means a record learned a tenant the resolver should have derived.
    const allowedEnclosing = new Set([
      'HeldActionContext',
      'HeldActionSummary',
      'ObservationRecord',
      'ObservationAggregate',
      'DeclassificationGrant',
      'ControlPlaneJournalCollections',
      'getControlPlaneForScope',
      'TenantScopedItem',
    ]);
    const result = safeExecResult(
      'git',
      ['grep', '-n', 'tenantSlug?: string', '--', 'libs/core/cloudflare-os-*.ts'],
      { cwd: rootDir() }
    );
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const [file, lineNo] = line.split(':');
      const source = String(safeReadFile(rootDir() + '/' + file)).split('\n');
      let enclosing = '';
      for (let i = Number(lineNo) - 1; i >= 0 && i > Number(lineNo) - 60; i--) {
        const match = source[i].match(/(interface|type|function|class)\s+(\w+)/);
        if (match) {
          enclosing = match[2];
          break;
        }
      }
      expect(
        allowedEnclosing.has(enclosing),
        `${file}:${lineNo} declares tenantSlug outside the allowed set (${enclosing})`
      ).toBe(true);
    }
  });
});
