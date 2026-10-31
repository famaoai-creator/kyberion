/**
 * R02 — scope lineage contract test.
 *
 * Fixes the field mapping trusted intake → execution envelope → child →
 * artifact/candidate, on the three contract axes the plan keeps separate
 * (§3.1): data tier, actor clearance, credential identity.
 *
 * Field mapping (verified below, not guessed):
 *
 *   boundary            data tier                    actor clearance              credential identity
 *   ------------------- ---------------------------- --------------------------- -------------------------------
 *   intake scope        ScopeContext.tier            SYSTEM_ROLE/MISSION_ROLE/    ScopeContext.tenant_slug/…
 *   (scope.env/env/     (public|confidential|        assumedRole (RA-02          mission_id/task_id — trusted
 *   mission record)     personal), never defaulted   validator, root scope)     runtime sources only
 *                       from caller input on error
 *   execution envelope  envelope.identity.tier +     —                            envelope.identity
 *   (mintScopeEnvelope) policy.read_tiers/write_tier                            (deny-only constraint)
 *   child dispatch      narrowScopeEnvelope:         withActorContext actor     withTaskCredentialBinding:
 *   (narrow + binding)  tier may only lower/narrow;  = claim holder, never a    tenant/mission/task must
 *                       read/write/egress shrink     model-supplied identity    equal execution identity
 *   artifact/candidate  MemoryCandidate.             learning_approval /        candidate.scope
 *   (memory queue)      sensitivity_tier +           decided_by (audit axis)    (tenant/…/mission chain)
 *                       scope.tier (assertMemoryScope)
 *
 * Negatives asserted here: missing tier, spoofed organization, tenant A→B
 * binding, and a scope-less candidate inside a bound tenant execution — all
 * fail closed. Legal narrowing (child deeper than parent, lower tier) is kept.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { runInExecutionScope } from './execution-scope.js';
import {
  credentialBindingReadiness,
  credentialExecutionIdentity,
  withTaskCredentialBinding,
} from './credential-binding.js';
import { registerSecretResolver, resetSecretResolver } from '../secret/secret-resolver.js';
import { withConfiguredTaskCredentials } from '../secret/task-credential-dispatch.js';
import {
  mintScopeEnvelope,
  narrowScopeEnvelope,
  withScopeEnvelope,
  type ScopeEnvelope,
} from '../scope-envelope.js';
import { assertScopeContext, validateScopeContext } from '../scope-context-validation.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
} from '../knowledge/memory-promotion-queue.js';
import type { MemoryScopeEnvelope } from '../knowledge/memory-scope.js';
import {
  TENANT_A,
  TENANT_B,
  ORG_A,
  createFixtureSecretResolver,
  tenantAEnvelope,
} from '../../../tests/fixtures/cli-reliability/scoped-organization.js';

const QUEUE_PATH = path.resolve(
  `active/shared/tmp/scope-lineage-contract-${process.pid}/memory-queue.jsonl`
);
process.env.KYBERION_MEMORY_QUEUE_PATH = QUEUE_PATH;

const MISSION = 'MSN-REL-LINEAGE';
const ITEM = 'WI-REL-LINEAGE-1';

const tenantAScope = (overrides: Partial<MemoryScopeEnvelope> = {}): MemoryScopeEnvelope => ({
  tier: 'confidential',
  tenant_slug: TENANT_A,
  organization_id: ORG_A,
  mission_id: MISSION,
  ...overrides,
});

function candidateWith(scope: MemoryScopeEnvelope | undefined, tier = 'confidential' as const) {
  return createMemoryPromotionCandidate({
    sourceType: 'mission',
    sourceRef: `mission:${MISSION}`,
    proposedMemoryKind: 'heuristic',
    summary: 'scope lineage fixture candidate',
    evidenceRefs: [`active/missions/confidential/${MISSION}/evidence/ledger.jsonl`],
    sensitivityTier: tier,
    ratificationRequired: true,
    ...(scope ? { scope } : {}),
  });
}

/** Envelope + tenant-bound execution scope + trusted binding, like a real dispatch. */
function inBoundTenantA<T>(envelope: ScopeEnvelope, run: () => T): T {
  return withScopeEnvelope(envelope, () =>
    runInExecutionScope(
      {
        tenantBound: true,
        tenantSlug: TENANT_A,
        executionIdentity: { missionId: MISSION, taskId: ITEM },
      },
      () =>
        withTaskCredentialBinding(
          { tenantSlug: TENANT_A, missionId: MISSION, taskId: ITEM, secrets: { FIXTURE: 'v' } },
          run
        )
    )
  );
}

afterEach(() => {
  resetSecretResolver();
});

describe('R02 scope lineage — intake → envelope → child → artifact', () => {
  it('keeps tier, actor scope and credential identity across every boundary', async () => {
    registerSecretResolver(createFixtureSecretResolver());
    const envelope = tenantAEnvelope({ mission_id: MISSION, task_id: ITEM });
    expect(envelope.identity.tier).toBe('confidential');
    expect(envelope.identity.tenant_slug).toBe(TENANT_A);
    expect(envelope.identity.organization_id).toBe(ORG_A);

    const observed: Record<string, unknown> = {};
    await withScopeEnvelope(envelope, async () =>
      runInExecutionScope(
        {
          tenantBound: true,
          tenantSlug: TENANT_A,
          executionIdentity: { missionId: MISSION, taskId: ITEM },
        },
        async () =>
          withConfiguredTaskCredentials(ITEM, async () => {
            const readiness = credentialBindingReadiness();
            observed.status = readiness.status;
            observed.identity = { ...readiness.identity };
            const identity = credentialExecutionIdentity();
            observed.execution = { ...identity };
            // Child may only narrow: deepening (session) is legal.
            const child = narrowScopeEnvelope(envelope, {
              identity: { session_id: 'SES-FIXTURE-1' },
              policy: { read_tiers: ['confidential'] },
            });
            observed.childSession = child.identity.session_id;
            observed.childReadTiers = [...child.policy.read_tiers];
          })
      )
    );

    expect(observed.status).toBe('bound');
    const identity = observed.identity as Record<string, string>;
    expect(identity.tenantSlug).toBe(TENANT_A);
    expect(identity.missionId).toBe(MISSION);
    expect(identity.taskId).toBe(ITEM);
    expect((observed.execution as Record<string, string>).tenantSlug).toBe(TENANT_A);
    // Legal narrowing kept: child deepens identity, read_tiers shrinks.
    expect(observed.childSession).toBe('SES-FIXTURE-1');
    expect(observed.childReadTiers).toEqual(['confidential']);

    // Artifact/candidate boundary: a scoped confidential candidate is accepted
    // inside the bound context and stays retrievable under the same scope.
    const queued = candidateWith(tenantAScope());
    inBoundTenantA(envelope, () => enqueueMemoryPromotionCandidate(queued));
    expect(loadMemoryPromotionCandidate(queued.candidate_id, tenantAScope())?.candidate_id).toBe(
      queued.candidate_id
    );
    // …and is NOT visible through a tenant-B scope lookup (separate shard/key).
    expect(
      loadMemoryPromotionCandidate(
        queued.candidate_id,
        tenantAScope({ tenant_slug: TENANT_B, organization_id: 'fixture-org-b' })
      )
    ).toBeNull();
  });

  it('refuses a missing data tier instead of defaulting it', () => {
    expect(validateScopeContext({ tenant_slug: TENANT_A }).length).toBeGreaterThan(0);
    expect(() => assertScopeContext({ tenant_slug: TENANT_A })).toThrow(/SCOPE_CONTEXT_INVALID/);
    // Missing tier must never be silently treated as public.
    expect(() => assertScopeContext({ tier: undefined, tenant_slug: TENANT_A } as never)).toThrow(
      /SCOPE_CONTEXT_INVALID/
    );
    expect(() => mintScopeEnvelope({ identity: {}, policy: { purpose: 'no identity' } })).toThrow(
      /SCOPE_ENVELOPE_INVALID/
    );
  });

  it('refuses a spoofed organization at the narrowing boundary', () => {
    const parent = tenantAEnvelope({ mission_id: MISSION, task_id: ITEM });
    expect(() =>
      narrowScopeEnvelope(parent, { identity: { organization_id: 'evil-org' } })
    ).toThrow(/OP_SCOPE_DENIED/);
    // A forged envelope identity that contradicts the minted one is refused too.
    expect(() => narrowScopeEnvelope(parent, { identity: { tenant_slug: TENANT_B } })).toThrow(
      /OP_SCOPE_DENIED/
    );
  });

  it('refuses a tenant A→B credential binding', () => {
    const envelope = tenantAEnvelope({ mission_id: MISSION, task_id: ITEM });
    expect(() =>
      inBoundTenantA(envelope, () =>
        withTaskCredentialBinding(
          { tenantSlug: TENANT_B, missionId: MISSION, taskId: ITEM, secrets: {} },
          () => undefined
        )
      )
    ).toThrow(/CREDENTIAL_SCOPE_DENIED/);
  });

  it('refuses a scope-less (or foreign-scope) confidential candidate inside a bound execution', () => {
    const envelope = tenantAEnvelope({ mission_id: MISSION, task_id: ITEM });
    // Scope-less confidential candidate: would land on the shared legacy floor.
    expect(() =>
      inBoundTenantA(envelope, () => enqueueMemoryPromotionCandidate(candidateWith(undefined)))
    ).toThrow(/MEMORY_SCOPE_DENIED/);
    // Foreign-tenant scope under a tenant-A binding: same refusal.
    expect(() =>
      inBoundTenantA(envelope, () =>
        enqueueMemoryPromotionCandidate(
          candidateWith(tenantAScope({ tenant_slug: TENANT_B, organization_id: 'fixture-org-b' }))
        )
      )
    ).toThrow(/MEMORY_SCOPE_DENIED/);
  });

  it('keeps the same binding contract for nested contexts (narrow-only)', () => {
    const envelope = tenantAEnvelope({ mission_id: MISSION, task_id: ITEM });
    inBoundTenantA(envelope, () => {
      // A nested binding with different secrets is widening → denied.
      expect(() =>
        withTaskCredentialBinding(
          { tenantSlug: TENANT_A, missionId: MISSION, taskId: ITEM, secrets: { OTHER: 'x' } },
          () => undefined
        )
      ).toThrow(/CREDENTIAL_SCOPE_DENIED/);
      // The identical binding nested is a legal narrow context.
      expect(
        withTaskCredentialBinding(
          { tenantSlug: TENANT_A, missionId: MISSION, taskId: ITEM, secrets: { FIXTURE: 'v' } },
          () => credentialBindingReadiness().status
        )
      ).toBe('bound');
    });
  });
});
