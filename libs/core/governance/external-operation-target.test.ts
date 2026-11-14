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
  tenant: undefined as string | undefined,
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
vi.mock('../scope-context.js', () => ({
  resolveScopeContext: () => ({ tier: state.tier, tenant_slug: state.tenant }),
}));
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
      data_tier: { read: ['public'], write: [] },
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

describe('reachable push source authority across tiers', () => {
  it.each(['public', 'personal', 'confidential'] as const)(
    'admits exact %s source scope only, with verified private destinations for nonpublic',
    (tier) => {
      const tenant = tier === 'confidential' ? 'acme' : undefined;
      state.tier = tier;
      state.tenant = tenant;
      const scope = tenant
        ? { kind: 'organization' as const, tenant_slug: tenant }
        : { kind: 'person' as const };
      const c = charter();
      c.scope = scope;
      c.envelope.data_tier.read = [tenant ? `confidential:${tenant}` : tier];
      c.envelope.external_operations = [
        {
          operation_id: 'vcs:push',
          repository: grant.repository,
          branch: 'feature',
          ...(tier !== 'public' ? { visibility: 'private' as const } : {}),
        },
      ];
      state.charter = c;
      const resolver = createOnboardingExternalOperationAuthority({
        scope,
        agentId: 'kyberion://agent/local/installed-worker',
        ownerActor: 'user:owner',
        invocationId: `push-${tier}`,
      });
      const input = {
        operationId: 'vcs:push',
        requiresApproval: true,
        delegable: true,
        effect: {
          url: grant.repository,
          destination: 'refs/heads/feature',
          publication_source_tier: tier,
          ...(tenant ? { publication_source_tenant: tenant } : {}),
          repository_visibility: tier === 'public' ? 'unknown' : 'private',
        },
      };
      expect(resolver(input)).toMatchObject({
        charter: { action: { data: { tier, mode: 'read' } } },
      });
      expect(
        resolver({ ...input, effect: { ...input.effect, publication_source_tier: undefined } })
      ).not.toHaveProperty('charter');
      expect(
        resolver({
          ...input,
          effect: { ...input.effect, publication_source_tier: 'protected_or_unknown' },
        })
      ).not.toHaveProperty('charter');
      if (tier !== 'public') {
        expect(
          resolver({ ...input, effect: { ...input.effect, repository_visibility: 'unknown' } })
        ).not.toHaveProperty('charter');
        expect(
          resolver({ ...input, effect: { ...input.effect, repository_visibility: 'public' } })
        ).not.toHaveProperty('charter');
      }
      expect(
        resolver({
          ...input,
          effect: { ...input.effect, publication_source_tenant: 'other' },
        })
      ).not.toHaveProperty('charter');
      if (tier === 'public') {
        expect(
          resolver({
            ...input,
            effect: { ...input.effect, publication_source_tier: 'personal' },
          })
        ).not.toHaveProperty('charter');
      }
    }
  );
});

beforeEach(() => {
  vi.restoreAllMocks();
  state.installed = false;
  state.active = true;
  state.envelope = undefined;
  state.tier = 'public';
  state.tenant = undefined;
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
  it('parses branch_pattern grants and rejects every wildcard except a tree prefix', () => {
    const pattern = {
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch_pattern: 'feat/*',
    };
    expect(parseExternalOperationGrant(pattern)).toEqual(pattern);
    // 'feat/**' and the refs form canonicalize to the single-wildcard tree.
    expect(parseExternalOperationGrant({ ...pattern, branch_pattern: 'feat/**' })).toEqual(pattern);
    expect(
      parseExternalOperationGrant({ ...pattern, branch_pattern: 'refs/heads/feat/*' })
    ).toEqual(pattern);
    for (const branch_pattern of [
      '*',
      '**',
      'feat*', // prefix must end at a tree boundary
      'fe*t/*',
      'feat/*/x',
      'feat/**/x',
      'feat/?x*',
      'feat/x*',
      'feat/**/**',
      ' feat/* ',
      'feat/ *',
      '*/*',
      'x*',
    ])
      expect(parseExternalOperationGrant({ ...pattern, branch_pattern })).toBeUndefined();
    // Ambiguous grants and pattern on non-branch operations are not grants.
    expect(parseExternalOperationGrant({ ...pattern, branch: 'main' })).toBeUndefined();
    expect(
      parseExternalOperationGrant({
        operation_id: 'vcs:pr_create',
        repository: pattern.repository,
        branch_pattern: 'feat/*',
      })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({ operation_id: 'vcs:push', branch_pattern: 'feat/*' })
    ).toBeUndefined();
  });
  it('covers branches directionally: pattern over target, never the reverse', () => {
    const pattern = parseExternalOperationGrant({
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch_pattern: 'feat/*',
    })!;
    const covered = {
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch: 'feat/login',
    };
    const uncovered = { ...covered, branch: 'main' };
    expect(externalOperationGrantMatches(pattern, covered)).toBe(true);
    expect(externalOperationGrantMatches(pattern, uncovered)).toBe(false);
    // 'feat/*' never matches 'feat' itself or sibling trees.
    expect(externalOperationGrantMatches(pattern, { ...covered, branch: 'feat' })).toBe(false);
    expect(externalOperationGrantMatches(pattern, { ...covered, branch: 'feature/x' })).toBe(false);
    // An exact grant cannot cover a pattern and a pattern cannot widen itself.
    const exact = parseExternalOperationGrant(covered)!;
    expect(externalOperationGrantMatches(exact, pattern)).toBe(false);
    const narrower = parseExternalOperationGrant({
      ...covered,
      branch_pattern: 'feat/sub/*',
      branch: undefined,
    })!;
    expect(externalOperationGrantMatches(pattern, narrower)).toBe(true);
    expect(externalOperationGrantMatches(narrower, pattern)).toBe(false);
    // Repository still must match exactly.
    expect(
      externalOperationGrantMatches(pattern, {
        ...covered,
        repository: 'https://github.com/acme/other',
      })
    ).toBe(false);
  });
  it('delegates push to a branch_pattern charter for covered refs only', () => {
    const grant = parseExternalOperationGrant({
      operation_id: 'vcs:push' as const,
      repository: 'https://github.com/acme/project',
      branch_pattern: 'feat/*',
    })!;
    const c = charter();
    c.envelope.external_operations = [grant];
    state.charter = c;
    expect(
      resolve()({
        operationId: 'vcs:push',
        requiresApproval: true,
        delegable: true,
        effect: {
          url: grant.repository,
          destination: 'refs/heads/feat/delegation',
          publication_source_tier: 'public',
        },
      })
    ).toMatchObject({
      charter: {
        action: {
          // The audit action records the exact executed target, not the pattern.
          external_operation: {
            operation_id: 'vcs:push',
            repository: grant.repository,
            branch: 'feat/delegation',
          },
          reputational_class: 'A',
        },
      },
    });
    expect(
      resolve()({
        operationId: 'vcs:push',
        requiresApproval: true,
        delegable: true,
        effect: {
          url: grant.repository,
          destination: 'refs/heads/main',
          publication_source_tier: 'public',
        },
      })
    ).not.toHaveProperty('charter');
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
      effect: {
        url: mergeGrant.repository,
        destination: 'refs/heads/release/1',
        publication_source_tier: 'public',
      },
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
        effect: {
          url: 'git@github.com:acme/project.git',
          destination: 'refs/heads/release/1',
          publication_source_tier: 'public',
        },
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
    state.tenant = 'acme';
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
  it('allows personal source only with person scope, explicit read and verified-private exact destination', () => {
    const c = charter();
    c.envelope.data_tier.read = ['personal'];
    c.envelope.external_operations = [{ ...grant, visibility: 'private' }];
    state.charter = c;
    state.tier = 'personal';
    const privateFacts = {
      ...facts,
      effect: { ...facts.effect, repository_visibility: 'private', body_source_tier: 'personal' },
    };
    expect(resolve()(privateFacts)).toMatchObject({
      charter: { action: { data: { tier: 'personal', mode: 'read' } } },
    });
    state.tenant = 'acme';
    expect(resolve()(privateFacts)).not.toHaveProperty('charter');
    state.tenant = undefined;
    expect(
      resolve()({
        ...privateFacts,
        effect: { ...privateFacts.effect, repository_visibility: 'public' },
      })
    ).not.toHaveProperty('charter');
    c.envelope.data_tier.read = ['public'];
    expect(resolve()(privateFacts)).not.toHaveProperty('charter');
  });
  it('confines confidential source, runtime, charter and body tenant to the same organization', () => {
    const c = charter();
    c.scope = { kind: 'organization', tenant_slug: 'acme' };
    c.envelope.data_tier.read = ['confidential:acme'];
    c.envelope.external_operations = [{ ...grant, visibility: 'private' }];
    state.charter = c;
    state.tier = 'confidential';
    state.tenant = 'acme';
    const resolver = createOnboardingExternalOperationAuthority({
      scope: c.scope,
      agentId: 'kyberion://agent/local/installed-worker',
      ownerActor: 'user:owner',
      invocationId: 'scoped',
    });
    const privateFacts = {
      ...facts,
      effect: {
        ...facts.effect,
        repository_visibility: 'private',
        body_source_tier: 'confidential',
        body_source_tenant: 'acme',
      },
    };
    expect(resolver(privateFacts)).toMatchObject({
      charter: { action: { data: { tier: 'confidential', tenant_slug: 'acme', mode: 'read' } } },
    });
    expect(
      resolver({ ...privateFacts, effect: { ...privateFacts.effect, body_source_tenant: 'beta' } })
    ).not.toHaveProperty('charter');
    state.tenant = 'beta';
    expect(resolver(privateFacts)).not.toHaveProperty('charter');
    state.tenant = 'acme';
    state.envelope = {
      identity: { tier: 'confidential', tenant_slug: 'acme' },
      policy: { read_tiers: ['public'], external_egress: 'allow' },
    };
    expect(resolver(privateFacts)).not.toHaveProperty('charter');
  });
  it('does not let public body provenance lower a private runtime or confidential body raise a public ceiling', () => {
    const c = charter();
    c.envelope.external_operations = [{ ...grant, visibility: 'private' }];
    c.envelope.data_tier.read = ['public', 'personal'];
    state.charter = c;
    state.tier = 'personal';
    expect(
      resolve()({
        ...facts,
        effect: { ...facts.effect, body_source_tier: 'public', repository_visibility: 'private' },
      })
    ).toMatchObject({ charter: { action: { data: { tier: 'personal' } } } });
    state.tier = 'public';
    expect(
      resolve()({
        ...facts,
        effect: { ...facts.effect, body_source_tier: 'personal', repository_visibility: 'private' },
      })
    ).not.toHaveProperty('charter');
    expect(
      resolve()({
        ...facts,
        effect: {
          ...facts.effect,
          body_source_tier: 'protected_or_unknown',
          repository_visibility: 'private',
        },
      })
    ).not.toHaveProperty('charter');
    c.envelope.data_tier.read = [];
    expect(resolve()(facts)).not.toHaveProperty('charter');
  });
  it.each(['vcs:push', 'vcs:pr_merge'] as const)(
    'uses the same exact private/read scope boundary for %s',
    (operationId) => {
      const c = charter();
      c.envelope.data_tier.read = ['personal'];
      c.envelope.external_operations = [
        {
          operation_id: operationId,
          repository: grant.repository,
          branch: 'main',
          visibility: 'private',
        },
      ];
      state.charter = c;
      state.tier = 'personal';
      const effect =
        operationId === 'vcs:push'
          ? {
              url: grant.repository,
              destination: 'refs/heads/main',
              repository_visibility: 'private',
              publication_source_tier: 'public',
            }
          : {
              repository: facts.effect.repository,
              baseRefName: 'main',
              repository_visibility: 'private',
            };
      const input = { operationId, requiresApproval: true, delegable: true, effect };
      expect(resolve()(input)).toMatchObject({
        charter: { action: { data: { tier: 'personal', mode: 'read' } } },
      });
      expect(
        resolve()({ ...input, effect: { ...effect, repository_visibility: 'public' } })
      ).not.toHaveProperty('charter');
      c.envelope.data_tier.read = ['public'];
      expect(resolve()(input)).not.toHaveProperty('charter');
    }
  );
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

describe('HOTL delegation surface (all external ops)', () => {
  it('network:fetch grant pins method + https origin and rejects method mismatches', () => {
    const effect = { params: { url: 'https://api.example.com/v1/x?q=1', method: 'post' } };
    expect(buildExternalOperationTarget('network:fetch', effect)).toEqual({
      operation_id: 'network:fetch',
      method: 'POST',
      origin: 'https://api.example.com',
    });
    const grant = parseExternalOperationGrant({
      operation_id: 'network:fetch',
      method: 'POST',
      origin: 'https://api.example.com',
    });
    expect(grant).toBeDefined();
    expect(
      externalOperationGrantMatches(
        grant!,
        buildExternalOperationTarget('network:fetch', effect) as never
      )
    ).toBe(true);
    const put = parseExternalOperationGrant({
      operation_id: 'network:fetch',
      method: 'PUT',
      origin: 'https://api.example.com',
    });
    expect(
      externalOperationGrantMatches(
        put!,
        buildExternalOperationTarget('network:fetch', effect) as never
      )
    ).toBe(false);
    // http or credentialed URLs are not delegable — they fall back to approval.
    expect(
      buildExternalOperationTarget('network:fetch', { params: { url: 'http://internal/x' } })
    ).toBeUndefined();
    expect(
      buildExternalOperationTarget('network:fetch', {
        params: { url: 'https://u:p@example.com/x' },
      })
    ).toBeUndefined();
  });

  it('network:shell grant binds the exact command string', () => {
    const target = buildExternalOperationTarget('network:shell', { params: { cmd: 'df -h' } });
    expect(target).toEqual({ operation_id: 'network:shell', cmd: 'df -h' });
    const grant = parseExternalOperationGrant({ operation_id: 'network:shell', cmd: 'df -h' });
    expect(externalOperationGrantMatches(grant!, target as never)).toBe(true);
    const other = parseExternalOperationGrant({ operation_id: 'network:shell', cmd: 'df -i' });
    expect(externalOperationGrantMatches(other!, target as never)).toBe(false);
    expect(
      parseExternalOperationGrant({ operation_id: 'network:shell', cmd: 'df *' })
    ).toBeUndefined();
  });

  it('network:a2a_send grant pins transport method + recipient peer', () => {
    const effect = {
      params: {
        method: 'local',
        message: { header: { msg_id: 'm1' }, recipient_peer_id: 'peer-b' },
      },
    };
    expect(buildExternalOperationTarget('network:a2a_send', effect)).toEqual({
      operation_id: 'network:a2a_send',
      method: 'local',
      peer_id: 'peer-b',
    });
    const grant = parseExternalOperationGrant({
      operation_id: 'network:a2a_send',
      method: 'local',
      peer_id: 'peer-b',
    });
    expect(
      externalOperationGrantMatches(
        grant!,
        buildExternalOperationTarget('network:a2a_send', effect) as never
      )
    ).toBe(true);
    // An envelope without a recipient identity cannot build a delegation target.
    expect(
      buildExternalOperationTarget('network:a2a_send', {
        params: { method: 'local', message: { header: { msg_id: 'm1' } } },
      })
    ).toBeUndefined();
  });

  it('meeting session grants must name exactly one meeting or series scope', () => {
    const effect = { params: { platform: 'zoom', series_id: 'cal-9' } };
    expect(buildExternalOperationTarget('meeting:join', effect)).toEqual({
      operation_id: 'meeting:join',
      platform: 'zoom',
      series_id: 'cal-9',
    });
    // A bare platform grant is invalid — delegation always names its scope.
    expect(
      parseExternalOperationGrant({ operation_id: 'meeting:join', platform: 'zoom' })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({
        operation_id: 'meeting:join',
        platform: 'zoom',
        meeting_id: 'm1',
        series_id: 's1',
      })
    ).toBeUndefined();
    const grant = parseExternalOperationGrant({
      operation_id: 'meeting:join',
      platform: 'zoom',
      series_id: 'cal-9',
    });
    expect(
      externalOperationGrantMatches(
        grant!,
        buildExternalOperationTarget('meeting:join', effect) as never
      )
    ).toBe(true);
    // Series id wins over meeting id in the emitted target.
    expect(
      buildExternalOperationTarget('meeting:chat', {
        params: { platform: 'zoom', meeting_id: 'm1', series_id: 's1' },
      })
    ).toEqual({ operation_id: 'meeting:chat', platform: 'zoom', series_id: 's1' });
    // Joining a meeting with no stable scope stays on per-action approval.
    expect(
      buildExternalOperationTarget('meeting:join', { params: { platform: 'zoom' } })
    ).toBeUndefined();
  });

  it('voice grants pin platform (+optional artifact hash for playback)', () => {
    expect(
      buildExternalOperationTarget('voice:playback', {
        params: { platform: 'macos', format: 'wav', content_hash: 'abc' },
      })
    ).toEqual({
      operation_id: 'voice:playback',
      platform: 'macos',
      format: 'wav',
      content_hash: 'abc',
    });
    expect(buildExternalOperationTarget('voice:speak', { params: { platform: 'macos' } })).toEqual({
      operation_id: 'voice:speak',
      platform: 'macos',
    });
    const artifact = parseExternalOperationGrant({
      operation_id: 'voice:playback',
      platform: 'macos',
      content_hash: 'abc',
    });
    const target = buildExternalOperationTarget('voice:playback', {
      params: { platform: 'macos', format: 'wav', content_hash: 'abc' },
    });
    expect(externalOperationGrantMatches(artifact!, target as never)).toBe(true);
  });

  it('calendar grants pin backend + optional calendar/event scope', () => {
    const effect = {
      op: 'delete_event',
      backend: 'google',
      params: { calendar_id: 'primary', event_id: 'ev-1' },
    };
    expect(buildExternalOperationTarget('calendar:delete_event', effect)).toEqual({
      operation_id: 'calendar:delete_event',
      backend: 'google',
      calendar_id: 'primary',
      event_id: 'ev-1',
    });
    const eventGrant = parseExternalOperationGrant({
      operation_id: 'calendar:delete_event',
      backend: 'google',
      event_id: 'ev-1',
    });
    expect(
      externalOperationGrantMatches(
        eventGrant!,
        buildExternalOperationTarget('calendar:delete_event', effect) as never
      )
    ).toBe(true);
    const otherEvent = parseExternalOperationGrant({
      operation_id: 'calendar:delete_event',
      backend: 'google',
      event_id: 'ev-2',
    });
    expect(
      externalOperationGrantMatches(
        otherEvent!,
        buildExternalOperationTarget('calendar:delete_event', effect) as never
      )
    ).toBe(false);
  });

  it('deployment grant pins adapter + environment (+optional project)', () => {
    const effect = {
      adapter: 'vercel',
      params: { environment: 'staging', project_name: 'web', version: '1.2.3', mission_id: 'M1' },
    };
    expect(buildExternalOperationTarget('deployment:deploy_release', effect)).toEqual({
      operation_id: 'deployment:deploy_release',
      adapter: 'vercel',
      environment: 'staging',
      project_name: 'web',
    });
    const staging = parseExternalOperationGrant({
      operation_id: 'deployment:deploy_release',
      adapter: 'vercel',
      environment: 'staging',
    });
    expect(
      externalOperationGrantMatches(
        staging!,
        buildExternalOperationTarget('deployment:deploy_release', effect) as never
      )
    ).toBe(true);
    const prod = parseExternalOperationGrant({
      operation_id: 'deployment:deploy_release',
      adapter: 'vercel',
      environment: 'production',
    });
    expect(
      externalOperationGrantMatches(
        prod!,
        buildExternalOperationTarget('deployment:deploy_release', effect) as never
      )
    ).toBe(false);
  });

  it('media generation grants pin the resolved backend_id', () => {
    const effect = { backend: { backend_id: 'comfyui.local' }, params: { prompt: 'x' } };
    expect(buildExternalOperationTarget('media:generation:generate_image', effect)).toEqual({
      operation_id: 'media:generation:generate_image',
      backend: 'comfyui.local',
    });
    const grant = parseExternalOperationGrant({
      operation_id: 'media:generation:generate_image',
      backend: 'comfyui.local',
    });
    expect(
      externalOperationGrantMatches(
        grant!,
        buildExternalOperationTarget('media:generation:generate_image', effect) as never
      )
    ).toBe(true);
    // A grant for a different media action never covers another operation id.
    const video = parseExternalOperationGrant({
      operation_id: 'media:generation:generate_video',
      backend: 'comfyui.local',
    });
    expect(
      externalOperationGrantMatches(
        video!,
        buildExternalOperationTarget('media:generation:generate_image', effect) as never
      )
    ).toBe(false);
  });

  it('slack post_message grants pin the channel', () => {
    const effect = { params: { channel: '#alerts', text: 'hi' } };
    expect(buildExternalOperationTarget('service:slack:preset:post_message', effect)).toEqual({
      operation_id: 'service:slack:preset:post_message',
      channel: '#alerts',
    });
    const grant = parseExternalOperationGrant({
      operation_id: 'service:slack:preset:post_message',
      channel: '#alerts',
    });
    expect(
      externalOperationGrantMatches(
        grant!,
        buildExternalOperationTarget('service:slack:preset:post_message', effect) as never
      )
    ).toBe(true);
  });
});

describe('bare operation grants', () => {
  it('a bare grant delegates the whole operation — all declared fields optional', () => {
    const bare = parseExternalOperationGrant({ operation_id: 'network:fetch' });
    expect(bare).toEqual({ operation_id: 'network:fetch' });
    const target = buildExternalOperationTarget('network:fetch', {
      params: { url: 'https://api.example.com/data', method: 'POST' },
    }) as never;
    expect(externalOperationGrantMatches(bare!, target)).toBe(true);
    // Other loose operations parse bare too.
    for (const op of [
      'network:shell',
      'network:exposure_check',
      'network:a2a_send',
      'voice:speak',
      'voice:playback',
      'calendar:create_event',
      'deployment:deploy_release',
      'media:generation:generate_image',
      'service:slack:preset:post_message',
      'browser:goto',
    ]) {
      expect(parseExternalOperationGrant({ operation_id: op }), op).toBeDefined();
    }
  });

  it('a scoped grant still narrows a bare-delegable operation', () => {
    const scoped = parseExternalOperationGrant({
      operation_id: 'network:fetch',
      method: 'GET',
      origin: 'https://api.example.com',
    });
    const getTarget = buildExternalOperationTarget('network:fetch', {
      params: { url: 'https://api.example.com/x', method: 'GET' },
    }) as never;
    const postTarget = buildExternalOperationTarget('network:fetch', {
      params: { url: 'https://api.example.com/x', method: 'POST' },
    }) as never;
    const otherOrigin = buildExternalOperationTarget('network:fetch', {
      params: { url: 'https://evil.example.com/x', method: 'GET' },
    }) as never;
    expect(externalOperationGrantMatches(scoped!, getTarget)).toBe(true);
    expect(externalOperationGrantMatches(scoped!, postTarget)).toBe(false);
    expect(externalOperationGrantMatches(scoped!, otherOrigin)).toBe(false);
    // A grant never widens: unknown keys and malformed origins stay rejected.
    expect(
      parseExternalOperationGrant({ operation_id: 'network:fetch', unknown: 'x' })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({
        operation_id: 'network:fetch',
        origin: 'http://insecure.example.com',
      })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({ operation_id: 'network:fetch', method: 'GET*' })
    ).toBeUndefined();
  });

  it('scope-essential grants keep their mandatory fields', () => {
    // VCS repository pinning is the semantic meaning of the grant.
    expect(parseExternalOperationGrant({ operation_id: 'vcs:push' })).toBeUndefined();
    expect(parseExternalOperationGrant({ operation_id: 'vcs:pr_create' })).toBeUndefined();
    // Tenant attestation binds the whole claim — nothing may be dropped.
    expect(parseExternalOperationGrant({ operation_id: 'tenant:attest_provider' })).toBeUndefined();
    expect(
      parseExternalOperationGrant({ operation_id: 'tenant:attest_provider', tenant_slug: 'acme' })
    ).toBeUndefined();
    // Meetings keep platform + exactly one of meeting_id/series_id.
    expect(
      parseExternalOperationGrant({ operation_id: 'meeting:join', platform: 'zoom' })
    ).toBeUndefined();
    expect(parseExternalOperationGrant({ operation_id: 'meeting:join' })).toBeUndefined();
    expect(
      parseExternalOperationGrant({
        operation_id: 'meeting:join',
        platform: 'zoom',
        meeting_id: 'm-1',
        series_id: 's-1',
      })
    ).toBeUndefined();
    expect(
      parseExternalOperationGrant({
        operation_id: 'meeting:join',
        platform: 'zoom',
        series_id: 's-1',
      })
    ).toBeDefined();
  });
});
