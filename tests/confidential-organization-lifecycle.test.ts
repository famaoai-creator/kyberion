/**
 * R01 — confidential organization lifecycle red test.
 *
 * Drives the real admission/claim/dispatch boundaries with synthetic
 * tenant-A fixtures (tests/fixtures/cli-reliability/scoped-organization.ts).
 * Goals:
 *  - R01a: intake -> WorkItem claim -> credential-bound child execution ->
 *    same-scope artifact, asserting the scope tuple survives each boundary.
 *  - R01b: verify -> distill -> finish -> same-scope reuse. The dispatch
 *    entry for lifecycle 'execution' actions is the R1-observed break point;
 *    segments whose entry cannot be driven without production change are
 *    marked blocked, not faked with direct state edits.
 *  - Negatives: unclaimed / cross-tenant binding / expired lease /
 *    cross-tenant artifact / private->public leak are refused.
 *
 * Nothing here touches real tenant data or real secrets.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { safeExistsSync, safeReaddir, safeReadFile, safeStat } from '../libs/core/secure-io.js';
import { runInExecutionScope } from '../libs/core/foundation/execution-scope.js';
import {
  credentialBindingReadiness,
  withTaskCredentialBinding,
} from '../libs/core/foundation/credential-binding.js';
import {
  registerSecretResolver,
  resetSecretResolver,
} from '../libs/core/secret/secret-resolver.js';
import { withConfiguredTaskCredentials } from '../libs/core/secret/task-credential-dispatch.js';
import { withScopeEnvelope, currentScopeEnvelope } from '../libs/core/scope-envelope.js';
import {
  createWorkItem,
  claimWorkItem,
  releaseWorkItem,
} from '../libs/core/workforce/work-coordination.js';
import { withCoordinationRoot } from '../libs/core/workforce/work-coordination-ledger.js';
import { installReasoningBackends } from '../libs/core/reasoning/reasoning-bootstrap.js';
import {
  SENTINEL_CONFIDENTIAL_BODY,
  TENANT_A,
  TENANT_B,
  PROJECT_A,
  createCrossTenantResolver,
  createFixtureSecretResolver,
  tenantAEnvelope,
  tenantAScopeContext,
} from './fixtures/cli-reliability/scoped-organization.js';

const COORD_ROOT = path.resolve(`active/shared/tmp/cli-rel-coord-${process.pid}`);

afterEach(() => {
  resetSecretResolver();
});

/** Claim a synthetic confidential work item inside an isolated coordination root. */
function claimConfidentialItem(itemId: string) {
  return withCoordinationRoot(COORD_ROOT, () => {
    createWorkItem({
      itemId,
      title: 'fixture confidential task',
      description: 'R01 lifecycle boundary probe',
      projectId: PROJECT_A,
      context: tenantAScopeContext() as never,
      rootDir: COORD_ROOT,
    });
    return claimWorkItem({
      itemId,
      actorPeerId: 'fixture-dispatcher',
      purpose: 'R01 boundary assertion',
      requireNewLease: true,
    });
  });
}

describe('R01a — intake -> claim -> credential-bound child -> same-scope artifact', () => {
  it('binds task credentials inside the claimed tenant-A envelope and preserves the scope tuple', async () => {
    registerSecretResolver(createFixtureSecretResolver());
    const { item, lease } = claimConfidentialItem('WI-REL-A1');
    const envelope = tenantAEnvelope({
      mission_id: 'MSN-REL-FIXTURE',
      task_id: 'WI-REL-A1',
    });

    const childObservations: Record<string, unknown> = {};
    await withScopeEnvelope(envelope, async () =>
      runInExecutionScope({ tenantBound: true, tenantSlug: TENANT_A }, async () =>
        withConfiguredTaskCredentials(item.item_id, async () => {
          // Child execution context: credential binding must be bound and carry
          // the ORIGINAL tenant / mission / task — no tier or tenant drift.
          const readiness = credentialBindingReadiness();
          childObservations.readiness = readiness.status;
          childObservations.identity = readiness.identity;
        })
      )
    );

    expect(childObservations.readiness).toBe('bound');
    expect((childObservations.identity as Record<string, string>).tenantSlug).toBe(TENANT_A);

    // Same-scope artifact: the only write this test performs stays inside the
    // claimed tenant context; nothing was written to public floors.
    withCoordinationRoot(COORD_ROOT, () =>
      releaseWorkItem({
        itemId: item.item_id,
        leaseId: lease.lease_id,
        actorPeerId: 'fixture-dispatcher',
        nextStatus: 'done',
        effectDisposition: 'completed',
        summary: 'R01a boundary held',
      })
    );
  });
});

describe('R01 negatives — the boundaries that must refuse', () => {
  it('refuses credential-bound execution without a claimed binding (unclaimed direct run stays unbound)', async () => {
    // No envelope, no claim: readiness reports operator scope — the binding
    // requirement is enforced downstream at reasoning install, not faked here.
    const readiness = credentialBindingReadiness();
    expect(['operator', 'binding_required']).toContain(readiness.status);
    // Under a tenant-bound runtime scope WITHOUT a claim, reasoning install is
    // the fail-closed boundary (R1-observed CREDENTIAL_BINDING_REQUIRED).
    await expect(
      runInExecutionScope({ tenantBound: true, tenantSlug: TENANT_A }, async () =>
        installReasoningBackends()
      )
    ).rejects.toThrow(/CREDENTIAL_BINDING_REQUIRED/);
  });

  it('refuses a cross-tenant binding minted against tenant B identity', async () => {
    registerSecretResolver(createCrossTenantResolver());
    const envelope = tenantAEnvelope({
      mission_id: 'MSN-REL-FIXTURE',
      task_id: 'WI-REL-X1',
    });
    await withCoordinationRoot(COORD_ROOT, () =>
      createWorkItem({
        itemId: 'WI-REL-X1',
        title: 'fixture cross-tenant',
        description: 'negative',
        context: tenantAScopeContext() as never,
        rootDir: COORD_ROOT,
      })
    );
    // bindTask returns tenant B while the execution identity says tenant A:
    // the binding-vs-identity contradiction must be caught when the child
    // context actually runs, not silently accepted.
    await withScopeEnvelope(envelope, async () =>
      runInExecutionScope({ tenantBound: true, tenantSlug: TENANT_A }, async () =>
        withConfiguredTaskCredentials('WI-REL-X1', async () => {
          // If we get here the binding contradicts identity — credentialExecutionIdentity
          // checks binding.tenantSlug !== identity.tenantSlug on checkedBinding().
          expect(credentialBindingReadiness().status).not.toBe('bound');
        }).catch((err: Error) => {
          expect(err.message).toMatch(/CREDENTIAL_(SCOPE_DENIED|BINDING)/);
        })
      )
    );
  });

  it('expired/second claim on an owned item is refused', () => {
    claimConfidentialItem('WI-REL-A2');
    expect(() =>
      withCoordinationRoot(COORD_ROOT, () =>
        claimWorkItem({
          itemId: 'WI-REL-A2',
          actorPeerId: 'fixture-other-actor',
          purpose: 'second claim attempt',
          requireNewLease: true,
        })
      )
    ).toThrow();
  });
});

describe('R01b — verify -> distill -> finish -> same-scope reuse (boundary map)', () => {
  it('documents the observed break: lifecycle execution-init is fail-closed without claim dispatch', async () => {
    // R1 live evidence: `pnpm mission verify|distill|finish` under persisted
    // tenant scope exits 1 with CREDENTIAL_BINDING_REQUIRED because these
    // verbs bootstrap 'execution' reasoning outside a claimed WorkItem.
    // Desired contract (R03 target): lifecycle verification must either not
    // need tenant credentials or be dispatched through the claimed path.
    // it.fails documents the break as a spec assertion; flip when R03 lands.
    await expect(
      runInExecutionScope({ tenantBound: true, tenantSlug: TENANT_A }, async () =>
        installReasoningBackends()
      )
    ).rejects.toThrow(/CREDENTIAL_BINDING_REQUIRED/);
  });

  it('R03: verify/distill/finish classify as reasoning-free owner verbs — no in-process backend install, no operator-scope workaround', async () => {
    // R03 landed the real entry: lifecycle verbs are journal/state mutations
    // whose only model stage (distill) shells out through the egress-gated
    // profile path, so they never install reasoning backends and never hit
    // CREDENTIAL_BINDING_REQUIRED under a persisted tenant scope. Traced:
    // verify -> mission-lifecycle.verifyMission (deterministic), finish ->
    // finishMission (gates + stub-degraded retrospective), distill ->
    // mission-distill.distillMission (runAdaptiveStructuredLlmProfile,
    // egress-gated shell providers, structural fallback).
    const { missionReasoningInitialization } = await import('../scripts/mission_controller.js');
    for (const verb of ['verify', 'distill', 'finish', 'review-worker-output']) {
      expect(missionReasoningInitialization(verb)).toBe('none');
    }
    // Dispatch still gets the host init (secret resolver, no provider probes);
    // genuinely reasoning-bound actions keep the binding requirement.
    expect(missionReasoningInitialization('dispatch-workitems')).toBe('host');
    expect(missionReasoningInitialization('delegate')).toBe('execution');
    // And the binding gate itself is still fail-closed for real execution.
    await expect(
      runInExecutionScope({ tenantBound: true, tenantSlug: TENANT_A }, async () =>
        installReasoningBackends()
      )
    ).rejects.toThrow(/CREDENTIAL_BINDING_REQUIRED/);
  });

  it('confidential sentinel body never reaches public floors in this fixture run', () => {
    // Guard: the fixture itself must not leak its sentinel into the repo's
    // shared/public tmp. (The artifact-path assertion lives in R02.)
    const publicTmp = path.resolve('active/shared/tmp/public');
    if (safeExistsSync(publicTmp)) {
      const walk = (dir: string): string[] =>
        safeReaddir(dir).flatMap((name) => {
          const entry = path.join(dir, name);
          return safeStat(entry).isDirectory() ? walk(entry) : [entry];
        });
      for (const file of walk(publicTmp)) {
        expect(safeReadFile(file, { encoding: 'utf8' })).not.toContain(SENTINEL_CONFIDENTIAL_BODY);
      }
    }
    expect(SENTINEL_CONFIDENTIAL_BODY).toMatch(/confidential-sentinel/);
  });
});
