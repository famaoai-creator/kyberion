import { beforeEach, describe, expect, it } from 'vitest';
import {
  contextSecurityScopeFromEnvelope,
  currentScopeEnvelope,
  envelopeNarrowRequestErrors,
  getMintedEnvelope,
  identityNarrowErrors,
  isScopeEnvelopeShape,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  noteMissingScopeEnvelope,
  policyNarrowErrors,
  resetScopeEnvelopeState,
  scopeEnvelopeMetrics,
  securityScopeNarrowErrors,
  withScopeEnvelope,
  type ScopeEnvelope,
} from './scope-envelope.js';
import type { ContextSecurityScope } from './context-security-scope.js';

const missingScopeEnv = 'active/shared/tmp/scope-envelope-test-missing.env';

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    KYBERION_TIER: 'confidential',
    KYBERION_TENANT: 'tenant-a',
    KYBERION_ORGANIZATION_ID: 'org-a',
    KYBERION_PROJECT_ID: 'proj-a',
    MISSION_ID: 'mission-x',
    KYBERION_TASK_ID: 'task-1',
    KYBERION_SCOPE_ENV_PATH: missingScopeEnv,
    ...overrides,
  }) as NodeJS.ProcessEnv;

const policy = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'test work',
  ...overrides,
});

const mint = (overrides: Record<string, string> = {}, input: Record<string, unknown> = {}) => {
  const { policy: inputPolicy, ...rest } = input as { policy?: Record<string, unknown> };
  return mintScopeEnvelope({
    env: env(overrides),
    policy: { ...policy(), ...(inputPolicy ?? {}) },
    ...rest,
  });
};

beforeEach(() => resetScopeEnvelopeState());

describe('mintScopeEnvelope', () => {
  it('derives identity from authenticated env sources and registers the mint', () => {
    const envelope = mint();
    expect(envelope.identity.tenant_slug).toBe('tenant-a');
    expect(envelope.identity.organization_id).toBe('org-a');
    expect(envelope.identity.project_id).toBe('proj-a');
    expect(envelope.identity.mission_id).toBe('mission-x');
    expect(envelope.identity.task_id).toBe('task-1');
    expect(envelope.identity.tier).toBe('confidential');
    expect(getMintedEnvelope(envelope.mint_ref)).toBe(envelope);
  });

  it('defaults policy read_tiers to cumulative tiers up to the identity tier', () => {
    const envelope = mint();
    expect(envelope.policy.read_tiers).toEqual(['public', 'confidential']);
    expect(envelope.policy.write_tier).toBe('confidential');
  });

  it('rejects a declared identity that contradicts the process scope', () => {
    expect(() =>
      mintScopeEnvelope({
        env: env(),
        identity: { mission_id: 'mission-other' },
        policy: policy(),
      })
    ).toThrow('[SCOPE_ENVELOPE_INVALID]');
  });

  it('requires session_id for mission-less envelopes', () => {
    expect(() =>
      mintScopeEnvelope({
        env: env({
          MISSION_ID: '',
          KYBERION_TASK_ID: '',
          KYBERION_TENANT: '',
          KYBERION_TIER: 'public',
        }),
        policy: policy(),
      })
    ).toThrow(/session_id/);
  });

  it('mints a session-bound mission-less envelope with tenant from the session binding', () => {
    const envelope = mintScopeEnvelope({
      env: env({ MISSION_ID: '', KYBERION_TASK_ID: '', KYBERION_TIER: 'public' }),
      identity: { session_id: 'session-1' },
      policy: policy(),
    });
    expect(envelope.identity.mission_id).toBeUndefined();
    expect(envelope.identity.tenant_slug).toBe('tenant-a');
  });

  it('pins unbound session envelopes to public-only policy', () => {
    const envelope = mintScopeEnvelope({
      env: env({
        MISSION_ID: '',
        KYBERION_TASK_ID: '',
        KYBERION_TENANT: '',
        KYBERION_TIER: 'public',
      }),
      identity: { session_id: 'session-1' },
      policy: policy(),
    });
    expect(envelope.policy.read_tiers).toEqual(['public']);
  });

  it('requires a purpose and a write tier inside read_tiers', () => {
    expect(() => mintScopeEnvelope({ env: env(), policy: { purpose: '' } as never })).toThrow(
      '[SCOPE_ENVELOPE_INVALID]'
    );
    expect(() =>
      mintScopeEnvelope({
        env: env(),
        policy: { purpose: 'x', read_tiers: ['public'], write_tier: 'confidential' },
      })
    ).toThrow(/write_tier/);
  });
});

describe('narrowScopeEnvelope', () => {
  it('allows policy narrowing and identity deepening', () => {
    const parent = mint();
    const child = narrowScopeEnvelope(parent, {
      identity: { session_id: 'session-1' },
      policy: { read_tiers: ['public'], write_tier: 'public' },
    });
    expect(child.mint_ref).not.toBe(parent.mint_ref);
    expect(child.policy.read_tiers).toEqual(['public']);
    expect(child.identity.session_id).toBe('session-1');
    expect(child.identity.mission_id).toBe('mission-x');
  });

  it.each([
    [{ policy: { read_tiers: ['public', 'confidential', 'personal'] } }, 'read_tiers'],
    [{ policy: { write_tier: 'personal' } }, 'write_tier'],
    [{ policy: { external_egress: 'allow' } }, 'external_egress'],
    [{ identity: { mission_id: 'mission-y' } }, 'mission_id'],
    [{ identity: { tenant_slug: 'tenant-b' } }, 'tenant_slug'],
  ])('denies enlargement via %j', (request, field) => {
    const parent = mint();
    expect(() => narrowScopeEnvelope(parent, request as never)).toThrow('[OP_SCOPE_DENIED]');
  });
});

describe('envelopeNarrowRequestErrors', () => {
  it('rejects a forged mint_ref', () => {
    const forged = {
      mint_ref: 'forged-ref',
      minted_at: new Date().toISOString(),
      identity: { tier: 'public' },
      policy: { read_tiers: ['public'], write_tier: 'public', purpose: 'x' },
    };
    const errors = envelopeNarrowRequestErrors(forged, undefined);
    expect(errors.join(' ')).toContain('not a runtime-issued envelope');
  });

  it('accepts a narrowed envelope against the active envelope', () => {
    const parent = mint();
    const child = narrowScopeEnvelope(parent, {
      policy: { read_tiers: ['public'], write_tier: 'public' },
    });
    const errors = withScopeEnvelope(parent, () =>
      envelopeNarrowRequestErrors(child, currentScopeEnvelope())
    );
    expect(errors).toEqual([]);
  });

  it('denies a caller envelope whose policy widens the minted one', () => {
    const parent = mint({}, { policy: { read_tiers: ['public'], write_tier: 'public' } });
    const widened = {
      ...parent,
      mint_ref: parent.mint_ref,
      policy: { ...parent.policy, read_tiers: ['public', 'confidential'] },
    } as ScopeEnvelope;
    const errors = withScopeEnvelope(parent, () =>
      envelopeNarrowRequestErrors(widened, currentScopeEnvelope())
    );
    expect(errors.join(' ')).toContain('read_tiers');
  });
});

describe('securityScopeNarrowErrors', () => {
  const securityScope = (overrides: Partial<ContextSecurityScope> = {}): ContextSecurityScope => ({
    tenant_slug: 'tenant-a',
    mission_id: 'mission-x',
    read_tiers: ['public', 'confidential'],
    write_tier: 'confidential',
    purpose: 'work',
    ...overrides,
  });

  it('passes a scope inside the minted envelope', () => {
    const envelope = mint();
    expect(securityScopeNarrowErrors(securityScope(), envelope)).toEqual([]);
  });

  it('denies identity contradictions and policy enlargement', () => {
    const envelope = mint();
    expect(
      securityScopeNarrowErrors(securityScope({ tenant_slug: 'tenant-b' }), envelope)
    ).not.toEqual([]);
    expect(
      securityScopeNarrowErrors(securityScope({ read_tiers: ['public', 'personal'] }), envelope)
    ).not.toEqual([]);
    expect(
      securityScopeNarrowErrors(securityScope({ external_egress: 'allow' }), envelope)
    ).not.toEqual([]);
  });
});

describe('envelope projections and activation', () => {
  it('projects a mission envelope to ContextSecurityScope and refuses mission-less', () => {
    const envelope = mint();
    const projected = contextSecurityScopeFromEnvelope(envelope);
    expect(projected?.mission_id).toBe('mission-x');
    expect(projected?.tenant_slug).toBe('tenant-a');

    const missionless = mintScopeEnvelope({
      env: env({ MISSION_ID: '', KYBERION_TASK_ID: '', KYBERION_TIER: 'public' }),
      identity: { session_id: 's-1' },
      policy: policy(),
    });
    expect(contextSecurityScopeFromEnvelope(missionless)).toBeNull();
  });

  it('exposes the active envelope through withScopeEnvelope', () => {
    const envelope = mint();
    expect(currentScopeEnvelope()).toBeUndefined();
    const seen = withScopeEnvelope(envelope, () => currentScopeEnvelope());
    expect(seen).toBe(envelope);
    expect(isScopeEnvelopeShape(envelope)).toBe(true);
  });
});

describe('missing-envelope metrics', () => {
  it('counts ops without an envelope for the rollout measurement', () => {
    noteMissingScopeEnvelope('service:read');
    noteMissingScopeEnvelope('file:read');
    expect(scopeEnvelopeMetrics()).toEqual({
      missing: 2,
      ops: ['service:read', 'file:read'],
    });
  });
});

describe('identityNarrowErrors / policyNarrowErrors', () => {
  it('accepts deepening fields absent in the parent', () => {
    const parent = mint();
    const errors = identityNarrowErrors(parent.identity, {
      ...parent.identity,
      session_id: 'session-2',
    });
    expect(errors).toEqual([]);
  });

  it('rejects conflicting identity and widening policy', () => {
    const parent = mint();
    expect(
      identityNarrowErrors(parent.identity, { ...parent.identity, mission_id: 'mission-y' })
    ).not.toEqual([]);
    expect(policyNarrowErrors(parent.policy, { read_tiers: ['personal'] })).not.toEqual([]);
    expect(policyNarrowErrors(parent.policy, { external_egress: 'allow' })).not.toEqual([]);
  });
});
