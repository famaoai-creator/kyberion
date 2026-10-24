import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExternalOperationTarget,
  externalOperationGrantMatches,
  parseExternalOperationGrant,
  parseExternalOperationGrants,
} from './external-operation-target.js';
import {
  evaluateAgainstCharter,
  validateCharter,
  envelopeExceeds,
  type Charter,
} from './accountability-charter.js';
import {
  parseCharterForm,
  renderAcceptanceStatement,
  envelopeFromForm,
} from './charter-service.js';
const state = vi.hoisted(() => ({
  tier: 'public',
  charter: undefined as unknown,
  installed: false,
  active: true,
  envelope: undefined as unknown,
}));
vi.mock('../organization/onboarding-runtime-identity.js', () => ({
  inspectInstalledOnboardingRuntime: () =>
    state.installed
      ? {
          ready: true,
          ownerId: 'user:owner',
          agentId: 'kyberion://agent/local/installed-worker',
          agentActive: state.active,
        }
      : { ready: false, reason: 'fixture-not-installed' },
}));
import * as externalOps from './external-operation.js';
import { withExternalOperationOccurrence } from './external-operation-occurrence.js';
import { currentInstalledPersonCharterRuntime } from './person-charter-runtime.js';
vi.mock('../scope-context.js', () => ({ resolveScopeContext: () => ({ tier: state.tier }) }));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: () => state.envelope }));
vi.mock('./accountability-charter-registry.js', async (original) => ({
  ...(await original<typeof import('./accountability-charter-registry.js')>()),
  findActiveCharter: () => state.charter,
}));
import {
  createOnboardingExternalOperationAuthority,
  withRuntimeExternalOperationAuthority,
} from './external-operation-runtime.js';
const grant = {
  operation_id: 'vcs:pr_create' as const,
  repository: 'https://github.com/acme/project',
};
const nav = { operation_id: 'browser:goto' as const, origin: 'https://example.com' };
function charter(): Charter {
  return {
    charter_id: 'chr-person-test',
    scope: { kind: 'person' },
    accountable: {
      actor: 'user:owner',
      authority_basis: { kind: 'owner', evidence_ref: 'profile:owner' },
      accepted_at: '2026-10-01T00:00:00Z',
      expires_at: '2026-12-01T00:00:00Z',
      statement_sha256: 'a'.repeat(64),
      deputies: [],
    },
    envelope: {
      money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
      data_tier: { read: [], write: [] },
      external_effects: {},
      irreversible: 'named_actions_only',
      irreversible_named_actions: ['vcs:pr_create', 'browser:goto'],
      external_operations: [grant, nav],
    },
    appetite: {
      max_loss_per_incident: 0,
      reputational_class_max: 'B',
      blast_radius_max: { systems: 1, recipients: 1 },
      tripwires: ['manual-stop'],
    },
  };
}
const facts = {
  operationId: 'vcs:pr_create',
  requiresApproval: true,
  delegable: true,
  effect: {
    repository: { url: grant.repository, host: 'github.com', slug: 'acme/project' },
    title: 'Public change',
    body: 'Public summary',
    body_source_tier: 'inline',
  },
};
const resolve = () =>
  createOnboardingExternalOperationAuthority({
    scope: { kind: 'person' },
    agentId: 'kyberion://agent/local/installed-worker',
    ownerActor: 'user:owner',
    invocationId: 'actual-stable-command',
  });
beforeEach(() => {
  vi.restoreAllMocks();
  state.installed = false;
  state.active = true;
  state.envelope = undefined;
  state.tier = 'public';
  state.charter = charter();
});
describe('exact public operation target grants', () => {
  it('retains envelope egress/read ceilings and refuses substituting a different actual NHI', () => {
    state.envelope = {
      identity: { tier: 'public' },
      policy: { read_tiers: ['public'], external_egress: 'deny' },
    };
    expect(resolve()(facts)).not.toHaveProperty('charter');
    state.envelope = {
      identity: { tier: 'public' },
      policy: { read_tiers: ['confidential'], external_egress: 'allow' },
    };
    expect(resolve()(facts)).not.toHaveProperty('charter');
    state.envelope = {
      identity: { tier: 'public', nhi_id: 'kyberion://agent/local/another-worker' },
      policy: { read_tiers: ['public'], external_egress: 'allow' },
    };
    expect(() => resolve()(facts)).toThrow('EXTERNAL_AGENT_IDENTITY_MISMATCH');
  });
  it('generic pipeline installs only verified active targeted authority and keeps ordinary operations on the existing resolver', () => {
    state.installed = true;
    const installed = vi
      .spyOn(externalOps, 'withExternalOperationAuthority')
      .mockImplementation((_resolver, body) => body());
    withRuntimeExternalOperationAuthority(
      { runId: 'real-run', stepId: 'navigate', hasHuman: false },
      () => {
        const resolver = installed.mock.calls.at(-1)![0];
        expect(currentInstalledPersonCharterRuntime()?.ownerActor).toBe('user:owner');
        expect(resolver(facts)?.charter?.action.external_operation).toEqual(grant);
        expect(resolver({ ...facts, operationId: 'meeting:chat' })?.agentId).toBe(
          'pipeline-external-worker'
        );
      }
    );
    state.active = false;
    withRuntimeExternalOperationAuthority(
      { runId: 'real-run', stepId: 'navigate', hasHuman: false },
      () => {
        expect(currentInstalledPersonCharterRuntime()).toBeUndefined();
        expect(installed.mock.calls.at(-1)![0](facts)?.charter).toBeUndefined();
      }
    );
  });
  it('binds invocations to trusted pipeline steps and occurrences, while payload edits retain identity', () => {
    state.installed = true;
    const installed = vi
      .spyOn(externalOps, 'withExternalOperationAuthority')
      .mockImplementation((_resolver, body) => body());
    const key = (stepId: string, occurrence: string, body = 'public') =>
      withRuntimeExternalOperationAuthority({ runId: 'same-run', stepId }, () =>
        withExternalOperationOccurrence(
          occurrence,
          () =>
            installed.mock.calls.at(-1)![0]({ ...facts, effect: { ...facts.effect, body } })!
              .invocationId
        )
      );
    expect(key('one', '0')).toBe(key('one', '0', 'changed payload'));
    expect(key('one', '0')).not.toBe(key('two', '0'));
    expect(key('one', '0')).not.toBe(key('one', '1'));
  });
  it('does not delegate body files with unknown or protected provenance despite a public execution context', () => {
    for (const body_source_tier of ['protected_or_unknown', 'confidential', 'personal', undefined])
      expect(
        resolve()({ ...facts, effect: { ...facts.effect, body_source_tier } })
      ).not.toHaveProperty('charter');
  });
  it.each([
    'https://github.com/acme/*',
    'https://other@github.com/acme/project',
    'https://github.com/acme/project?q=secret',
    'http://github.com/acme/project',
  ])('rejects noncanonical repository %s', (repository) =>
    expect(parseExternalOperationGrant({ ...grant, repository })).toBeUndefined()
  );
  it('rejects opaque actions, target-path origins, wildcard and duplicate grants', () => {
    expect(
      parseExternalOperationGrant({ ...nav, operation_id: 'browser:evaluate' })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({ ...nav, origin: 'https://example.com/path' })
    ).toBeUndefined();
    expect(parseExternalOperationGrants([grant, grant])).toBeUndefined();
    expect(parseExternalOperationGrant({ ...grant, hasHuman: true })).toBeUndefined();
  });
  it('parses repository+branch grants for pr_merge and push, rejecting wildcard and missing branch', () => {
    const merge = {
      operation_id: 'vcs:pr_merge',
      repository: 'https://github.com/acme/project',
      branch: 'main',
    };
    const push = {
      operation_id: 'vcs:push',
      repository: 'https://github.com/acme/project',
      branch: 'refs/heads/feature/x',
    };
    expect(parseExternalOperationGrant(merge)).toEqual({
      operation_id: 'vcs:pr_merge',
      repository: 'https://github.com/acme/project',
      branch: 'main',
    });
    expect(parseExternalOperationGrant(push)).toEqual({
      operation_id: 'vcs:push',
      repository: 'https://github.com/acme/project',
      branch: 'feature/x',
    });
    expect(
      parseExternalOperationGrant({ ...merge, repository: 'https://github.com/acme/*' })
    ).toBeUndefined();
    expect(parseExternalOperationGrant({ ...merge, branch: 'ma*' })).toBeUndefined();
    expect(
      parseExternalOperationGrant({ operation_id: 'vcs:push', repository: merge.repository })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({ ...merge, repository: 'ssh://git@github.com/acme/project' })
    ).toBeUndefined();
  });
  it('parses optional visibility:private grants and binds verified-private effects', () => {
    const grant = {
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch: 'main',
      visibility: 'private' as const,
    };
    expect(parseExternalOperationGrant(grant)).toEqual({
      operation_id: 'vcs:push',
      repository: 'https://github.com/acme/project',
      branch: 'main',
      visibility: 'private',
    });
    // Non-private values and unknown optional keys still fail closed.
    expect(parseExternalOperationGrant({ ...grant, visibility: 'public' })).toBeUndefined();
    expect(parseExternalOperationGrant({ ...grant, unknown_field: 'x' })).toBeUndefined();
    // Effect target gains visibility only when verified private.
    const effect = {
      url: 'https://github.com/acme/project.git',
      destination: 'refs/heads/main',
      repository_visibility: 'private',
    };
    expect(buildExternalOperationTarget('vcs:push', effect)).toEqual(grant);
    expect(
      buildExternalOperationTarget('vcs:push', { ...effect, repository_visibility: 'public' })
    ).toEqual({ operation_id: 'vcs:push', repository: grant.repository, branch: 'main' });
    // A 'private'-scoped grant never matches an unverified/public target.
    expect(
      externalOperationGrantMatches(parseExternalOperationGrant(grant)!, {
        operation_id: 'vcs:push',
        repository: grant.repository,
        branch: 'main',
      } as never)
    ).toBe(false);
  });
  it('delegates pr_merge and push to exact repo+branch grants only', () => {
    const mergeGrant = {
      operation_id: 'vcs:pr_merge' as const,
      repository: 'https://github.com/acme/project',
      branch: 'main',
    };
    const pushGrant = {
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch: 'release/1',
    };
    const c = charter();
    c.envelope.external_operations = [mergeGrant, pushGrant];
    state.charter = c;
    const mergeAuthority = resolve()({
      operationId: 'vcs:pr_merge',
      requiresApproval: true,
      delegable: true,
      effect: {
        repository: { url: mergeGrant.repository, host: 'github.com', slug: 'acme/project' },
        baseRefName: 'main',
      },
    });
    expect(mergeAuthority).toMatchObject({
      charter: { action: { external_operation: mergeGrant, reputational_class: 'A' } },
    });
    const pushAuthority = resolve()({
      operationId: 'vcs:push',
      requiresApproval: true,
      delegable: true,
      effect: { url: mergeGrant.repository, destination: 'refs/heads/release/1' },
    });
    expect(pushAuthority).toMatchObject({
      charter: { action: { external_operation: pushGrant, reputational_class: 'A' } },
    });
    expect(
      resolve()({
        operationId: 'vcs:push',
        requiresApproval: true,
        delegable: true,
        effect: { url: mergeGrant.repository, destination: 'refs/heads/main' },
      })
    ).not.toHaveProperty('charter');
    expect(
      resolve()({
        operationId: 'vcs:push',
        requiresApproval: true,
        delegable: true,
        effect: { url: 'git@github.com:acme/project.git', destination: 'refs/heads/release/1' },
      })
    ).toMatchObject({ charter: { action: { external_operation: pushGrant } } });
  });
  it('resolves actual repository only and retains real person/agent identity without tenant', () => {
    const authority = resolve()(facts);
    expect(authority).toMatchObject({
      hasHuman: false,
      invocationId: expect.any(String),
      charter: {
        scope: { kind: 'person' },
        action: {
          external_operation: grant,
          actor: { id: 'kyberion://agent/local/installed-worker', on_behalf_of: 'user:owner' },
        },
      },
    });
    expect(authority).not.toHaveProperty('tenantSlug');
    expect(
      resolve()({
        ...facts,
        effect: {
          repository: {
            url: 'https://enterprise.example/acme/project',
            host: 'enterprise.example',
            slug: 'acme/project',
          },
        },
      })
    ).not.toHaveProperty('charter');
  });
  it('does not invent another charter owners on_behalf_of for the installed NHI', () => {
    const other = charter();
    other.scope = { kind: 'organization', tenant_slug: 'acme' };
    other.accountable.actor = 'user:other-owner';
    state.charter = other;
    const authority = createOnboardingExternalOperationAuthority({
      scope: other.scope,
      agentId: 'kyberion://agent/acme/installed-worker',
      ownerActor: 'user:owner',
      invocationId: 'owned-command',
    })(facts)!;
    expect(authority.charter!.action.actor.on_behalf_of).toBe('user:owner');
    expect(
      evaluateAgainstCharter({
        charter: other,
        action: authority.charter!.action,
        usage: { spent_today: 0, spent_this_month: 0, tripwires_hit: [] },
        availability: { accountable_available: true, available_deputies: [] },
        now: new Date('2026-10-21'),
      }).decision
    ).toBe('deny');
  });
  it.each(['personal', 'confidential', 'unknown'])('does not declassify %s context', (tier) => {
    state.tier = tier;
    expect(resolve()(facts)).not.toHaveProperty('charter');
  });
  it('never delegates opaque browser interactions or query URL egress', () => {
    for (const [operationId, url] of [
      ['browser:goto', 'https://example.com/public'],
      ['browser:goto', 'https://example.com/?secret=value'],
      ['browser:evaluate', 'https://example.com/public'],
      ['browser:open_tab', 'https://example.com/public'],
    ]) {
      const result = resolve()({
        ...facts,
        operationId,
        effect: { params: { url }, navigation_confinement: 'isolated-public-read-v1' },
      });
      expect(Boolean(result?.charter)).toBe(operationId === 'browser:goto' && !url.includes('?'));
    }
  });
  it('retains expiry, stop, availability and irreversible checks in the real evaluator', () => {
    const action = resolve()(facts)!.charter!.action;
    const evaluate = (over: Partial<Parameters<typeof evaluateAgainstCharter>[0]> = {}) =>
      evaluateAgainstCharter({
        charter: charter(),
        action,
        usage: { spent_today: 0, spent_this_month: 0, tripwires_hit: [] },
        availability: { accountable_available: true, available_deputies: [] },
        now: new Date('2026-10-21'),
        ...over,
      });
    expect(evaluate().decision).toMatch(/^allow/);
    expect(evaluate({ now: new Date('2027-01-01') }).decision).toBe('deny');
    expect(
      evaluate({ usage: { spent_today: 0, spent_this_month: 0, tripwires_hit: ['manual-stop'] } })
        .decision
    ).toBe('stop');
    expect(
      evaluate({ availability: { accountable_available: false, available_deputies: [] } }).decision
    ).toBe('deny');
    const restricted = charter();
    restricted.envelope.irreversible = 'forbid';
    expect(evaluate({ charter: restricted }).decision).toBe('deny');
    expect(
      envelopeExceeds(charter().envelope, { ...charter().envelope, external_operations: [] })
    ).not.toEqual([]);
    const invalid = charter();
    invalid.envelope.external_operations = [{ ...grant, repository: 'https://github.com/*/*' }];
    expect(
      validateCharter(invalid, { holder_role: 'owner', now: new Date('2026-10-21') })
    ).not.toEqual([]);
  });
  it('signs person scope, exact operation, owner, expiry and public-only restrictions', () => {
    const parsed = parseCharterForm({
      scope_kind: 'person',
      tenant_slug: '',
      per_action: 0,
      per_day: 0,
      per_month: 0,
      max_loss_per_incident: 0,
      expires_in_days: 30,
      reputational_class_max: 'B',
      external_operations: [grant],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = renderAcceptanceStatement({
      form: parsed.form,
      accountableId: 'user:owner',
      displayName: 'Owner',
      now: new Date('2026-10-21'),
    });
    for (const value of [
      'vcs:pr_create',
      grant.repository,
      'user:owner',
      '2026-11-20',
      'Public execution context',
    ])
      expect(text).toContain(value);
    expect(envelopeFromForm(parsed.form).irreversible_named_actions).toContain('vcs:pr_create');
  });
});

describe('tenant:attest_provider delegation grants', () => {
  const attest = {
    operation_id: 'tenant:attest_provider' as const,
    tenant_slug: 'acme',
    provider: 'claude',
    training_use: 'none' as const,
    plan: 'Claude Code subscription',
    basis: 'operator-declared terms',
    attested_by: 'user:owner',
  };
  it('parses an exact attestation grant and matches it verbatim', () => {
    expect(parseExternalOperationGrant(attest)).toEqual(attest);
    expect(parseExternalOperationGrants([attest])).toEqual([attest]);
  });
  it('rejects non-none training_use, wildcards, unknown fields and missing claim fields', () => {
    expect(parseExternalOperationGrant({ ...attest, training_use: 'used' })).toBeUndefined();
    expect(parseExternalOperationGrant({ ...attest, provider: 'cla*' })).toBeUndefined();
    expect(parseExternalOperationGrant({ ...attest, valid_for_days: 30 })).toBeUndefined();
    const { attested_by: _omit, ...incomplete } = attest;
    expect(parseExternalOperationGrant(incomplete)).toBeUndefined();
    expect(parseExternalOperationGrant({ ...attest, plan: '  ' })).toBeUndefined();
  });
  it('buildTarget trims claim fields but only builds the egress-opening claim', () => {
    const effect = {
      tenant_slug: ' acme ',
      provider: 'claude',
      training_use: 'none',
      plan: ' plan ',
      basis: ' basis ',
      attested_by: ' user:owner ',
    };
    expect(buildExternalOperationTarget('tenant:attest_provider', effect)).toEqual({
      ...attest,
      plan: 'plan',
      basis: 'basis',
      attested_by: 'user:owner',
    });
    expect(
      buildExternalOperationTarget('tenant:attest_provider', { ...effect, training_use: 'used' })
    ).toBeUndefined();
    expect(
      buildExternalOperationTarget('tenant:attest_provider', { ...effect, plan: 42 })
    ).toBeUndefined();
  });
});
