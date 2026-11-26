import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { resetRoleAssumptionPolicyCache, resolveRole, withExecutionContext } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { inspectReadPermission, validateWritePermission } from '../tier-guard.js';
import { withRunManifestBinding } from '../governance/run-manifest-binding.js';
import { withRunManifestGateStore } from '../governance/run-manifest-gate-runtime.js';
import {
  runManifestGateCoversCharterScope,
  withRunManifestGateStoreAccess,
} from '../governance/run-manifest-gate-store.js';
import { computeRunManifestHash, type RunManifest } from '../pipeline/run-manifest.js';

// pipeline-run-manifest-model §3.5: a manifest-bound native run dispatches
// under surface_runtime; its gate reads and records exactly its own tenant's
// governance state through the run-manifest gate store grant.
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_BASE_ROLE',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ORGANIZATION_ID',
] as const;
const at = (relative: string) => path.join(ROOT, relative);
const allowed = (decision: { allowed: boolean }) => decision.allowed;

function manifestFor(tenant: string, marker: string): RunManifest {
  const body = {
    version: 2,
    scope: { tier: 'confidential', tenant_slug: tenant },
    source: { path: `knowledge/confidential/${tenant}/x.json`, marker },
    requirements: { effects: [] },
  } as unknown as Omit<RunManifest, 'manifest_hash'>;
  return { ...body, manifest_hash: computeRunManifestHash(body) } as RunManifest;
}

const manifest = manifestFor('acme', 'one');
const otherManifest = manifestFor('acme', 'two');
const H = manifest.manifest_hash;
const H2 = otherManifest.manifest_hash;
const charters = 'knowledge/confidential/acme/charters';
const rmDir = `${charters}/run-manifests/${H}`;
const rmCharter = `${rmDir}/rm-aaaa.json`;
const rmLedger = `${rmDir}/rm-aaaa.ledger.jsonl`;
const orgCharter = `${charters}/chr-org.json`;
const orgLedger = `${charters}/chr-org.ledger.jsonl`;
const otherManifestCharter = `${charters}/run-manifests/${H2}/rm-bbbb.json`;
const otherTenantCharter = 'knowledge/confidential/other/charters/chr-org.json';
const otherTenantLedger = `knowledge/confidential/other/charters/run-manifests/${H}/rm-aaaa.ledger.jsonl`;
const tenantKnowledge = 'knowledge/confidential/acme/secret.json';
const otherTenantScratch = 'active/shared/tmp/confidential/other/browser/handoff.json';
const reviewName = `${'a'.repeat(64)}-${'b'.repeat(64)}.json`;
const review = `active/shared/artifacts/confidential/acme/evidence/external-operation-review/${reviewName}`;
const index = 'active/shared/artifacts/confidential/acme/artifacts-index.jsonl';
const reservation = `active/shared/runtime/external-operations/confidential/acme/${'c'.repeat(64)}.json`;

/** surface_runtime bound to acme, inside a run-manifest binding and its gate store. */
function inGate<T>(fn: () => T, runId = 'run-1'): T {
  return withExecutionContext(
    'surface_runtime',
    () =>
      withRunManifestBinding(
        { manifest, charterId: 'rm-aaaa', principal: 'attended', runId: 'run-1' },
        () => withRunManifestGateStore({ tenantSlug: 'acme', runId, manifestHash: H }, fn)
      ),
    undefined,
    'acme'
  );
}

describe('tier-guard run-manifest gate store grant', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  it('surface_runtime alone cannot read the governance state the gate needs', () => {
    withExecutionContext(
      'surface_runtime',
      () => {
        for (const file of [rmCharter, rmLedger, orgCharter])
          expect(allowed(inspectReadPermission(at(file), 'read')), file).toBe(false);
      },
      undefined,
      'acme'
    );
  });

  it('a binding alone confers no I/O; a charter-read grant reads exactly its own tenant and manifest', () => {
    inGate(() => {
      expect(allowed(inspectReadPermission(at(rmCharter), 'read'))).toBe(false);
      withRunManifestGateStoreAccess(
        'charter-read',
        [charters, rmDir, orgCharter, orgLedger, rmCharter, rmLedger],
        [],
        () => {
          expect(resolveRole()).toBe('surface_runtime');
          expect(currentExecutionScope()?.tenantSlug).toBe('acme');
          for (const file of [rmCharter, rmLedger, orgCharter, orgLedger])
            expect(allowed(inspectReadPermission(at(file), 'read')), file).toBe(true);
          expect(allowed(inspectReadPermission(at(rmDir), 'read'))).toBe(true);
          // Nothing outside the exact files: another manifest, another tenant, tenant knowledge.
          for (const file of [
            otherManifestCharter,
            otherTenantCharter,
            otherTenantLedger,
            tenantKnowledge,
            otherTenantScratch,
          ])
            expect(allowed(inspectReadPermission(at(file), 'read')), file).toBe(false);
          // Read-only kind: no write, not even of a file it may read.
          expect(allowed(validateWritePermission(at(rmLedger), 'append'))).toBe(false);
        }
      );
    });
  });

  it('refuses to issue a grant over any file outside the kind ceiling', () => {
    inGate(() => {
      for (const file of [
        otherManifestCharter,
        otherTenantCharter,
        otherTenantLedger,
        tenantKnowledge,
        otherTenantScratch,
        `${charters}/run-manifests/${H}/nested/rm-aaaa.json`,
        `${charters}/../secret.json`,
      ]) {
        const callback = vi.fn();
        expect(() => withRunManifestGateStoreAccess('charter-read', [file], [], callback)).toThrow(
          '[RUN_MANIFEST_GATE_SCOPE]'
        );
        expect(callback).not.toHaveBeenCalled();
      }
      // Ledger appends: the bound manifest's ledger only, never the standing charters'.
      expect(() =>
        withRunManifestGateStoreAccess('charter-ledger-write', [orgLedger], [orgLedger], vi.fn())
      ).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
      expect(() =>
        withRunManifestGateStoreAccess('charter-ledger-write', [rmCharter], [rmCharter], vi.fn())
      ).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
      expect(() =>
        withRunManifestGateStoreAccess(
          'review-write',
          [],
          ['active/shared/artifacts/confidential/other/artifacts-index.jsonl'],
          vi.fn()
        )
      ).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
      expect(() =>
        withRunManifestGateStoreAccess(
          'reservation-write',
          [],
          [`active/shared/runtime/external-operations/confidential/other/${'c'.repeat(64)}.json`],
          vi.fn()
        )
      ).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
    });
  });

  it('authorizes the run ledger append, review artifact and reservation of its own tenant', () => {
    inGate(() => {
      withRunManifestGateStoreAccess('charter-ledger-write', [rmLedger], [rmLedger], () => {
        expect(allowed(validateWritePermission(at(rmLedger), 'append'))).toBe(true);
        expect(allowed(validateWritePermission(at(orgLedger), 'append'))).toBe(false);
      });
      withRunManifestGateStoreAccess('review-write', [review, index], [review, index], () => {
        expect(allowed(validateWritePermission(at(review)))).toBe(true);
        expect(allowed(validateWritePermission(at(index), 'append'))).toBe(true);
      });
      withRunManifestGateStoreAccess('reservation-write', [], [reservation], () => {
        expect(allowed(validateWritePermission(at(reservation)))).toBe(true);
      });
    });
    // After the binding ends nothing is authorized.
    withExecutionContext(
      'surface_runtime',
      () => expect(allowed(validateWritePermission(at(rmLedger), 'append'))).toBe(false),
      undefined,
      'acme'
    );
  });

  it('narrows a broad caller to the exact grant while it is active', () => {
    withExecutionContext(
      'mission_controller',
      () =>
        withRunManifestBinding(
          { manifest, charterId: 'rm-aaaa', principal: 'attended', runId: 'run-1' },
          () =>
            withRunManifestGateStore(
              { tenantSlug: 'acme', runId: 'run-1', manifestHash: H },
              () => {
                const outside = 'active/shared/runtime/missions/state.json';
                withRunManifestGateStoreAccess('charter-read', [rmCharter], [], () => {
                  expect(allowed(validateWritePermission(at(outside)))).toBe(false);
                  expect(validateWritePermission(at(outside)).reason).toContain(
                    '[RUN_MANIFEST_GATE_SCOPE]'
                  );
                });
              }
            )
        ),
      undefined,
      'acme'
    );
  });

  it("opens only inside the run's own binding, for the manifest's tenant, never for another bound tenant", () => {
    const run = { tenantSlug: 'acme', runId: 'run-1', manifestHash: H };
    // No binding.
    expect(() => withRunManifestGateStore(run, vi.fn())).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
    // Another run or another manifest than the installed binding.
    expect(() => inGate(vi.fn(), 'run-2')).toThrow('[RUN_MANIFEST_GATE_SCOPE]');
    withRunManifestBinding(
      { manifest, charterId: 'rm-aaaa', principal: 'attended', runId: 'run-1' },
      () => {
        expect(() => withRunManifestGateStore({ ...run, manifestHash: H2 }, vi.fn())).toThrow(
          '[RUN_MANIFEST_GATE_SCOPE]'
        );
        // A location tenant that is not the manifest's.
        expect(() => withRunManifestGateStore({ ...run, tenantSlug: 'other' }, vi.fn())).toThrow(
          '[RUN_MANIFEST_GATE_SCOPE]'
        );
        // A caller bound to another tenant.
        withExecutionContext(
          'surface_runtime',
          () =>
            expect(() => withRunManifestGateStore(run, vi.fn())).toThrow(
              '[ROLE_TENANT_SCOPE_MISMATCH]'
            ),
          undefined,
          'other'
        );
      }
    );
  });

  it('covers only the bound tenant organization charters and the bound manifest', () => {
    inGate(() => {
      expect(runManifestGateCoversCharterScope({ kind: 'organization', tenant_slug: 'acme' })).toBe(
        true
      );
      expect(
        runManifestGateCoversCharterScope({
          kind: 'run_manifest',
          tenant_slug: 'acme',
          manifest_hash: H,
        })
      ).toBe(true);
      expect(
        runManifestGateCoversCharterScope({
          kind: 'run_manifest',
          tenant_slug: 'acme',
          manifest_hash: H2,
        })
      ).toBe(false);
      expect(
        runManifestGateCoversCharterScope({ kind: 'organization', tenant_slug: 'other' })
      ).toBe(false);
      expect(runManifestGateCoversCharterScope({ kind: 'person' })).toBe(false);
    });
  });

  it('refuses the issuance right as an assumable role and keeps who may issue', () => {
    expect(() =>
      withExecutionContext('run_manifest_gate_store', () => undefined, 'worker')
    ).toThrow('[ROLE_ASSUMPTION_DENIED]');
    process.env.SYSTEM_ROLE = 'zz_unlisted_surface';
    const callback = vi.fn();
    expect(() =>
      withRunManifestBinding(
        { manifest, charterId: 'rm-aaaa', principal: 'attended', runId: 'run-1' },
        () =>
          withRunManifestGateStore({ tenantSlug: 'acme', runId: 'run-1', manifestHash: H }, () =>
            withRunManifestGateStoreAccess('charter-read', [rmCharter], [], callback)
          )
      )
    ).toThrow('[ROLE_ASSUMPTION_DENIED]');
    expect(callback).not.toHaveBeenCalled();
  });
});
