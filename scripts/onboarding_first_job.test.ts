import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { FrontDeskExecutionPolicy } from '@agent/core/surface/front-desk-execution-contract';

const state = vi.hoisted(() => ({
  policy: { version: 1, mappings: [] } as FrontDeskExecutionPolicy,
  tenant: undefined as undefined | { status: string; metadata: Record<string, unknown> },
  charter: undefined as DotCharter | undefined,
  activationReady: true,
  writes: 0,
  creates: 0,
}));
vi.mock('@agent/core/foundation', async (original) => ({
  ...(await original<typeof import('@agent/core/foundation')>()),
  readJson: () => structuredClone(state.policy),
}));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeWriteFile: (path: string, value: string) => {
    if (path !== 'knowledge/product/governance/front-desk-execution-policy.json')
      throw new Error('unexpected write');
    state.writes++;
    state.policy = JSON.parse(value) as FrontDeskExecutionPolicy;
  },
}));
vi.mock('@agent/core/organization/tenant-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/organization/tenant-registry')>()),
  readTenantProfile: () => state.tenant,
}));
vi.mock('@agent/core/organization/tenant-governance', async (original) => ({
  ...(await original<typeof import('@agent/core/organization/tenant-governance')>()),
  mutateTenant: (input: { metadata: Record<string, unknown> }) => {
    state.creates++;
    state.tenant = { status: 'active', metadata: input.metadata };
  },
}));
vi.mock('@agent/core/dot/dot-charter', async (original) => ({
  ...(await original<typeof import('@agent/core/dot/dot-charter')>()),
  findDotCharter: () =>
    state.charter ? { charter: structuredClone(state.charter), path: 'dots/test.json' } : undefined,
}));
vi.mock('@agent/core/dot/dot-lifecycle', async (original) => ({
  ...(await original<typeof import('@agent/core/dot/dot-lifecycle')>()),
  checkDotActivationReadiness: () => ({ ready: state.activationReady, errors: [] }),
  createDraftDotCharter: (draft: DotCharter) => (state.charter = structuredClone(draft)),
  transitionDotCharterStatus: () => {
    if (!state.charter) throw new Error('missing draft');
    state.charter.status = 'active';
    return state.charter;
  },
}));

import { applyFirstJob, diagnosticDraft, main, planFirstJob } from './onboarding_first_job.js';

beforeEach(() => {
  state.policy = { version: 1, mappings: [] };
  state.tenant = undefined;
  state.charter = undefined;
  state.activationReady = true;
  state.writes = state.creates = 0;
  for (const key of ['MISSION_ID', 'SYSTEM_ROLE', 'KYBERION_TENANT']) vi.stubEnv(key, '');
});

describe('explicit first-job provisioning', () => {
  it('plans pure public tenant-only configuration without writes or identity grants', () => {
    const plan = planFirstJob('demo-first-job');
    expect(plan.status).toBe('awaiting_explicit_apply');
    expect(plan.mapping.viewer).toMatchObject({
      tenantSlugs: ['demo-first-job'],
      tierAccess: ['public'],
      organizationIds: 'all',
      projectIds: 'all',
    });
    expect(plan.draft.scope).toEqual({ tenant_slug: 'demo-first-job', tier: 'public' });
    expect(plan.draft.authority.max_concurrent_delegations).toBe(1);
    expect(state.writes + state.creates).toBe(0);
  });
  it('requires exact accepted plan before any configuration effect', () => {
    expect(() => applyFirstJob('demo-first-job', 'bad')).toThrow('first_job_plan_changed');
    expect(state.writes + state.creates).toBe(0);
  });
  it('creates through facades and maps only after active charter, then is idempotent', () => {
    const plan = planFirstJob('demo-first-job');
    const result = applyFirstJob('demo-first-job', plan.plan_digest);
    expect(result.status).toBe('already_configured');
    expect(state.charter?.status).toBe('active');
    expect(state.writes).toBe(1);
    expect(state.creates).toBe(1);
    applyFirstJob('demo-first-job', result.plan_digest);
    expect(state.writes).toBe(1);
  });
  it('refuses unrelated or suspended tenant records', () => {
    state.tenant = { status: 'active', metadata: {} };
    expect(() => planFirstJob('demo-first-job')).toThrow('first_job_existing_tenant_not_owned');
    state.tenant = {
      status: 'suspended',
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1' },
    };
    expect(() => planFirstJob('demo-first-job')).toThrow('first_job_existing_tenant_not_owned');
  });
  it('preserves a paused charter rather than silently reactivating', () => {
    state.tenant = {
      status: 'active',
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1' },
    };
    state.charter = { ...diagnosticDraft('demo-first-job'), status: 'paused' };
    expect(() => planFirstJob('demo-first-job')).toThrow('first_job_charter_not_active');
    expect(state.writes).toBe(0);
  });
  it('rejects ambiguous same-principal mappings', () => {
    const plan = planFirstJob('other-diagnostic');
    state.policy.mappings.push(plan.mapping);
    expect(() => planFirstJob('demo-first-job')).toThrow('first_job_mapping_conflict');
  });
  it('rejects changed plan state without writing', () => {
    const plan = planFirstJob('demo-first-job');
    state.tenant = {
      status: 'active',
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1' },
    };
    expect(() => applyFirstJob('demo-first-job', plan.plan_digest)).toThrow(
      'first_job_plan_changed'
    );
    expect(state.writes).toBe(0);
  });
  it('refuses ambient mission/system/other-tenant context', () => {
    vi.stubEnv('MISSION_ID', 'MSN-OTHER');
    expect(() => planFirstJob('demo-first-job')).toThrow('standalone_operator');
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('SYSTEM_ROLE', 'worker');
    expect(() => planFirstJob('demo-first-job')).toThrow('standalone_operator');
    vi.stubEnv('SYSTEM_ROLE', '');
    vi.stubEnv('KYBERION_TENANT', 'other');
    expect(() => planFirstJob('demo-first-job')).toThrow('ambient_tenant_conflict');
  });
  it('requires activation readiness and a valid tenant slug', () => {
    state.activationReady = false;
    expect(() => planFirstJob('demo-first-job')).toThrow('activation_not_ready');
    expect(() => planFirstJob('../secret')).toThrow('invalid_tenant');
  });
  it('defaults CLI to a read-only plan and rejects contradictory modes', async () => {
    const output: unknown[] = [];
    await main(['--tenant', 'demo-first-job'], (value) => output.push(value));
    expect(output).toHaveLength(1);
    expect(state.writes + state.creates).toBe(0);
    await expect(main(['--tenant', 'demo-first-job', '--apply', '--dry-run'])).rejects.toThrow(
      'conflicting_mode'
    );
    await expect(main(['--tenant', 'demo-first-job', '--tick', '--apply'])).rejects.toThrow(
      'conflicting_mode'
    );
  });
});
