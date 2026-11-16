import type { GrantRecord } from '../governance/grant-store.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  credentialBindingReadiness,
  credentialExecutionIdentity,
  resolveTaskCredential,
} from '../foundation/credential-binding.js';
import { resetScopeEnvelopeState } from '../scope-envelope.js';
import { installLocalCredentialAllocations } from '../secret/credential-allocations.js';
import { resetSecretResolver } from '../secret/secret-resolver.js';
import {
  clearWorkCoordinationStore,
  getWorkItem,
  listActiveWorkLeases,
  listWorkItems,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import type { DotCharter } from './dot-charter.js';
import { readDotWakeLedger } from './dot-runtime.js';
import { runDotWakeWithGoalDriver } from './dot-wake-orchestration.js';
import { runAsDotCharter } from './dot-key-results.js';
import { listClaimableDotWorkItems, reapStrandedDotWorkItems } from './dot-executor.js';

const ROOT_TMP = 'active/shared/tmp/vitest-dot-standing-reaper';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  dotStandingLineage,
  remindDotCredentialGrantExpiry,
  resetDotCredentialGrantReminders,
  withDotStandingBinding,
} from './dot-standing-binding.js';

const DAY = 86_400_000;
const state = vi.hoisted(() => ({
  grants: [] as GrantRecord[],
  read: vi.fn(),
}));
vi.mock('../governance/grant-store.js', async (original) => {
  const actual = await original<typeof import('../governance/grant-store.js')>();
  return {
    ...actual,
    listGrants: (options: { tenant_slug?: string }) =>
      state.grants.filter((grant) => grant.scope.tenant_slug === options.tenant_slug),
    loadGrant: (tenant: string, id: string) =>
      state.grants.find((grant) => grant.grant_id === id && grant.scope.tenant_slug === tenant) ??
      null,
    verifyGrantBasis: () => true,
  };
});
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJson: (path: string) => {
      if (path.replaceAll('\\', '/').endsWith('/knowledge/personal/connections/anthropic.json')) {
        state.read();
        return { api_key: 'synthetic-allocated-key' };
      }
      return actual.readJson(path);
    },
  };
});

function grant(tenant: string, expiresInDays: number, id = 'GRT-20261116-0000000000a1') {
  const now = Date.now();
  return {
    schema_version: 'grant-record.v1',
    grant_id: id,
    capability: 'credential.use',
    scope: {
      tenant_slug: tenant,
      credential_provider: 'anthropic',
      credential_ref: 'anthropic/API_KEY',
    },
    purpose: 'resident dot',
    granted_by: { actor_id: 'user:owner', role: 'sovereign', assurance: 'A1' },
    granted_at: new Date(now - 10 * DAY).toISOString(),
    expires_at: new Date(now + expiresInDays * DAY).toISOString(),
    audit_event_id: 'audit-1',
  };
}

function charter(tenant: string | undefined, dotId = `${tenant ?? 'public'}-ops`): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: dotId,
    version: '1.0.0',
    title: 'Ops',
    purpose: 'Standing binding fixture.',
    status: 'active',
    scope: tenant
      ? { tier: 'confidential', tenant_slug: tenant, organization_id: tenant }
      : { tier: 'public' },
    goal: { statement: 'Keep things running.' },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
    authority: { authority_role: 'organization_operator' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: `dot-${dotId}` },
  } as DotCharter;
}

const deps = { prepareHost: () => void installLocalCredentialAllocations() };
/** Where the supervisor would have loaded the charter from. */
const src = (c: DotCharter) => ({
  path: c.scope.tenant_slug
    ? `knowledge/confidential/${c.scope.tenant_slug}/dots/${c.dot_id}.json`
    : `dots/${c.dot_id}.json`,
  charter: c,
});
// Yield to the event loop so concurrent runs interleave (no wall-clock sleep).
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  state.grants = [];
  resetSecretResolver();
  resetScopeEnvelopeState();
  resetDotCredentialGrantReminders();
  setWorkCoordinationNamespace(`vitest-dot-standing-${randomUUID()}`);
  vi.stubEnv('KYBERION_SCOPE_ENV_PATH', 'active/shared/tmp/vitest-dot-standing-no-scope.env');
  for (const key of [
    'KYBERION_TENANT',
    'KYBERION_PROJECT_ID',
    'KYBERION_ORGANIZATION_ID',
    'MISSION_ID',
    'KYBERION_TASK_ID',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-operator-only');
});
afterEach(() => {
  vi.useRealTimers();
  clearWorkCoordinationStore();
  setWorkCoordinationNamespace(null);
  resetSecretResolver();
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});

describe('resident dot standing binding', () => {
  it('mints a binding from a claimed standing step and releases it afterwards', async () => {
    state.grants = [grant('alpha', 20)];
    const dot = charter('alpha');
    const lineage = dotStandingLineage(dot)!;
    expect(lineage.missionId).toMatch(/^MSN-DOT-[0-9A-F]{24}$/);
    expect(lineage.actorId).toBe('kyberion://agent/alpha/alpha/dot-alpha-ops');
    let stepId: string | undefined;
    const value = await withDotStandingBinding(
      src(dot),
      'wake',
      async () => {
        expect(credentialBindingReadiness().status).toBe('bound');
        const identity = credentialExecutionIdentity();
        expect(identity.tenantSlug).toBe('alpha');
        expect(identity.missionId).toBe(lineage.missionId);
        const step = listWorkItems().find((item) => item.parent_item_id === lineage.issueItemId)!;
        stepId = step.item_id;
        expect(step.status).toBe('in_progress');
        expect(step.parent_item_id).toBe(lineage.issueItemId);
        expect(step.claimed_by_peer_id).toBe(lineage.actorId);
        expect(step.context?.task_id).toBe(identity.taskId);
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('synthetic-allocated-key');
        return 'ok';
      },
      deps
    );
    expect(value).toBe('ok');
    expect(state.read).toHaveBeenCalled();
    // The reusable step returns to backlog (never ready); the attempt keeps the outcome.
    expect(getWorkItem(stepId!)?.status).toBe('backlog');
    expect(getWorkItem(stepId!)?.metadata?.execution_status).toBe('succeeded');
    expect(getWorkItem(lineage.issueItemId)?.status).not.toBe('review');
    // A second run reuses the same step: bounded WorkItems per dot.
    await withDotStandingBinding(src(dot), 'wake', async () => 'again', deps);
    expect(
      listWorkItems().filter((item) => item.parent_item_id === lineage.issueItemId)
    ).toHaveLength(1);
    expect(getWorkItem(stepId!)?.attempts?.length).toBe(2);
    expect(listActiveWorkLeases()).toHaveLength(0);
    // Outside the run nothing is bound: the operator path is unchanged.
    expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('keeps two tenants alternating in one process on their own bindings', async () => {
    state.grants = [grant('alpha', 20), grant('beta', 20, 'GRT-20261116-0000000000b2')];
    const seen: string[] = [];
    const runFor = (tenant: string) =>
      withDotStandingBinding(
        src(charter(tenant)),
        'wake',
        async () => {
          for (let i = 0; i < 3; i += 1) {
            await tick();
            const identity = credentialExecutionIdentity();
            expect(identity.tenantSlug).toBe(tenant);
            expect(identity.missionId).toBe(dotStandingLineage(charter(tenant))!.missionId);
            expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('synthetic-allocated-key');
            seen.push(tenant);
          }
          return tenant;
        },
        deps
      );
    expect(await Promise.all([runFor('alpha'), runFor('beta')])).toEqual(['alpha', 'beta']);
    // Interleaved, not serialized: both tenants were bound at the same time.
    expect(seen.slice(0, 2).sort()).toEqual(['alpha', 'beta']);
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('refuses one tenant without a grant while the other tenant runs bound', async () => {
    state.grants = [grant('alpha', 20)];
    const [alpha, beta] = await Promise.allSettled([
      withDotStandingBinding(
        src(charter('alpha')),
        'wake',
        async () => {
          await tick();
          return resolveTaskCredential('ANTHROPIC_API_KEY');
        },
        deps
      ),
      withDotStandingBinding(src(charter('beta')), 'wake', async () => 'ran', deps),
    ]);
    expect(alpha).toEqual({ status: 'fulfilled', value: 'synthetic-allocated-key' });
    expect(beta.status).toBe('rejected');
    expect(String((beta as PromiseRejectedResult).reason)).toContain(
      '[DOT_CREDENTIAL_GRANT_MISSING]'
    );
    expect(String((beta as PromiseRejectedResult).reason)).toContain(
      'pnpm kyberion reasoning credentials assign --tenant beta'
    );
  });

  it('leaves a tenantless dot unchanged: no claim, no binding', async () => {
    const value = await withDotStandingBinding(
      src(charter(undefined)),
      'wake',
      async () => {
        expect(credentialBindingReadiness().status).toBe('operator');
        return resolveTaskCredential('ANTHROPIC_API_KEY');
      },
      deps
    );
    expect(value).toBeUndefined();
    expect(listWorkItems()).toHaveLength(0);
  });

  it('classifies an expired grant with the exact extension command and runs nothing', async () => {
    state.grants = [grant('alpha', -2)];
    const run = vi.fn(async () => 'ran');
    await expect(withDotStandingBinding(src(charter('alpha')), 'wake', run, deps)).rejects.toThrow(
      /\[DOT_CREDENTIAL_GRANT_EXPIRED\].*pnpm kyberion reasoning credentials extend --tenant alpha --grant GRT-20261116-0000000000a1/
    );
    expect(run).not.toHaveBeenCalled();
    // Expired beyond the grace window is no longer extendable: request a new grant.
    state.grants = [grant('alpha', -30)];
    await expect(withDotStandingBinding(src(charter('alpha')), 'wake', run, deps)).rejects.toThrow(
      '[DOT_CREDENTIAL_GRANT_MISSING]'
    );
  });

  it('revalidates at every use: a revoked grant fails closed mid-run', async () => {
    const live = grant('alpha', 20);
    state.grants = [live];
    await withDotStandingBinding(
      src(charter('alpha')),
      'executor',
      async () => {
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('synthetic-allocated-key');
        Object.assign(live, {
          revoked: {
            at: new Date(Date.now() - 1000).toISOString(),
            by: 'user:owner',
            audit_event_id: 'a',
          },
        });
        expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
          'CREDENTIAL_ALLOCATION_DENIED'
        );
      },
      deps
    );
  });

  it('fails closed when the standing claim is lost and still finishes cleanly', async () => {
    state.grants = [grant('alpha', 20)];
    const lineage = dotStandingLineage(charter('alpha'))!;
    await withDotStandingBinding(
      src(charter('alpha')),
      'wake',
      async () => {
        const step = listWorkItems().find(
          (item) => item.parent_item_id === lineage.issueItemId && item.status === 'in_progress'
        )!;
        releaseWorkItem({
          itemId: step.item_id,
          leaseId: step.lease_id!,
          actorPeerId: lineage.actorId,
          nextStatus: 'blocked',
        });
        expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
          /CREDENTIAL_BINDING_UNAVAILABLE|CREDENTIAL_ALLOCATION_DENIED/
        );
      },
      deps
    );
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('never binds tenant credentials to a repo-level charter that only declares the tenant', async () => {
    state.grants = [grant('alpha', 20)];
    const run = vi.fn(async () => 'ran');
    await expect(
      withDotStandingBinding(
        { path: 'dots/alpha-ops.json', charter: charter('alpha') },
        'wake',
        run,
        deps
      )
    ).rejects.toThrow('[DOT_STANDING_CHARTER_UNBOUND]');
    // Another tenant's directory does not qualify either.
    await expect(
      withDotStandingBinding(
        { path: 'knowledge/confidential/beta/dots/alpha-ops.json', charter: charter('alpha') },
        'wake',
        run,
        deps
      )
    ).rejects.toThrow('[DOT_STANDING_CHARTER_UNBOUND]');
    expect(run).not.toHaveBeenCalled();
    expect(listWorkItems()).toHaveLength(0);
  });

  it('classifies a grant for another provider than the charter routes to before claiming', async () => {
    state.grants = [grant('alpha', 20)];
    const dot = {
      ...charter('alpha'),
      runtime: { heartbeat_id: 'dot-alpha-ops', reasoning_backend: 'openai' },
    } as DotCharter;
    await expect(withDotStandingBinding(src(dot), 'wake', async () => 'ran', deps)).rejects.toThrow(
      /\[DOT_CREDENTIAL_GRANT_MISSING\].*--provider openai/
    );
    const cli = {
      ...charter('alpha'),
      runtime: { heartbeat_id: 'dot-alpha-ops', reasoning_backend: 'claude-cli' },
    } as DotCharter;
    // A legacy anthropic API grant does not feed claude-cli; the fix is a lent credential.
    await expect(withDotStandingBinding(src(cli), 'wake', async () => 'ran', deps)).rejects.toThrow(
      /\[DOT_CREDENTIAL_GRANT_MISSING\].*--credential .*--backends claude-cli/
    );
    const unknown = {
      ...charter('alpha'),
      runtime: { heartbeat_id: 'dot-alpha-ops', reasoning_backend: 'gemini-cli' },
    } as DotCharter;
    await expect(
      withDotStandingBinding(src(unknown), 'wake', async () => 'ran', deps)
    ).rejects.toThrow(/not an allocatable API provider/);
    expect(listWorkItems()).toHaveLength(0);
  });

  it('recovers a step orphaned by a crashed run without escalating dot work', async () => {
    state.grants = [grant('alpha', 20)];
    const dot = charter('alpha');
    const lineage = dotStandingLineage(dot)!;
    // A 1 ms lease lapses before release: the step is left in_progress, like a crash.
    await withDotStandingBinding(src(dot), 'wake', async () => 'x', { ...deps, leaseMs: 1 }).catch(
      () => undefined
    );
    const orphan = listWorkItems().find((item) => item.parent_item_id === lineage.issueItemId)!;
    // Move the clock past the 1 ms lease deterministically instead of sleeping.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 1000));
    expect(getWorkItem(orphan.item_id)?.status).toBe('in_progress');
    // The dot work reaper and claimable list ignore standing steps entirely.
    expect(listClaimableDotWorkItems(dot, { rootDir: ROOT_TMP })).toHaveLength(0);
    reapStrandedDotWorkItems([src(dot)], { rootDir: ROOT_TMP });
    expect(getWorkItem(orphan.item_id)?.metadata?.dot_executor).toBeUndefined();
    // The next run recovers the same step and runs bound.
    const value = await withDotStandingBinding(
      src(dot),
      'wake',
      async () => resolveTaskCredential('ANTHROPIC_API_KEY'),
      deps
    );
    expect(value).toBe('synthetic-allocated-key');
    const step = getWorkItem(orphan.item_id)!;
    expect(step.status).toBe('backlog');
    expect(step.attempts?.some((attempt) => attempt.failure_reason === 'lease_expired')).toBe(true);
    expect(listActiveWorkLeases()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('reminds the operator once a day before the grant expires', () => {
    const notify = vi.fn(() => true);
    state.grants = [grant('alpha', 3)];
    const now = new Date();
    expect(remindDotCredentialGrantExpiry(charter('alpha'), now, { notify })).toBe(true);
    expect(remindDotCredentialGrantExpiry(charter('alpha'), now, { notify })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls[0])).toContain(
      'pnpm kyberion reasoning credentials extend --tenant alpha'
    );
    state.grants = [grant('beta', 25, 'GRT-20261116-0000000000b2')];
    expect(remindDotCredentialGrantExpiry(charter('beta'), now, { notify })).toBe(false);
  });
});

describe('tenant dot wake through the standing binding', () => {
  const ROOT = 'active/shared/tmp/vitest-dot-standing-wake';
  afterEach(() => safeRmSync(ROOT, { recursive: true, force: true }));
  function loadedTenant(tenant: string) {
    const dot = {
      ...charter(tenant),
      runtime: { heartbeat_id: `dot-${tenant}-ops`, reasoning_training_use: 'no_training' },
    } as DotCharter;
    const dir = `${ROOT}/knowledge/confidential/${tenant}/dots`;
    safeMkdir(dir, { recursive: true });
    safeWriteFile(`${dir}/${dot.dot_id}.json`, JSON.stringify(dot));
    return { path: `${dir}/${dot.dot_id}.json`, charter: dot };
  }

  it('builds the task backend inside the binding and delivers', async () => {
    state.grants = [grant('alpha', 20)];
    let boundAtBuild: string | undefined;
    let boundInLoop: string | undefined;
    const loaded = loadedTenant('alpha');
    // The supervisor wakes inside runAsDotCharter (role + tenant, no lineage).
    const receipt = await runAsDotCharter(loaded.charter, () =>
      runDotWakeWithGoalDriver(loaded, {
        rootDir: ROOT,
        hasRole: () => true,
        standing: deps,
        taskBackend: () => {
          boundAtBuild = credentialBindingReadiness().status;
          return {
            name: 'anthropic',
            delegateTask: async () => 'unused',
            generateWithTools: async () => ({ text: '', toolCalls: [] }) as never,
          };
        },
        goalDriver: (async () => {
          boundInLoop = credentialBindingReadiness().status;
          expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('synthetic-allocated-key');
          return { turnsRun: 1, goal: { budgetStats: { tokensUsed: 3 } } };
        }) as never,
      })
    );
    expect(boundAtBuild).toBe('bound');
    expect(receipt.outcome).toBe('delivered');
    expect(boundInLoop).toBe('bound');
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('without the standing binding (pre-change path) a tenant wake cannot reach credentials', async () => {
    state.grants = [grant('alpha', 20)];
    const loaded = loadedTenant('alpha');
    const receipt = await runAsDotCharter(loaded.charter, () =>
      runDotWakeWithGoalDriver(loaded, {
        rootDir: ROOT,
        hasRole: () => true,
        // An injected backend skips the binding: this is the supervisor path before the change.
        backend: {
          name: 'anthropic',
          delegateTask: async () => 'unused',
          generateWithTools: async () => ({ text: '', toolCalls: [] }) as never,
        } as never,
        goalDriver: (async () => {
          resolveTaskCredential('ANTHROPIC_API_KEY');
          return { turnsRun: 1, goal: { budgetStats: { tokensUsed: 3 } } };
        }) as never,
      })
    );
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toContain('[CREDENTIAL_BINDING_REQUIRED]');
  });

  it('records a missing grant as a classified failed wake without any model call', async () => {
    const taskBackend = vi.fn();
    const receipt = await runDotWakeWithGoalDriver(loadedTenant('alpha'), {
      rootDir: ROOT,
      hasRole: () => true,
      standing: deps,
      taskBackend,
    });
    expect(receipt.outcome).toBe('failed');
    expect(receipt.reason).toContain('[DOT_CREDENTIAL_GRANT_MISSING]');
    expect(taskBackend).not.toHaveBeenCalled();
    const [row] = readDotWakeLedger({ rootDir: ROOT });
    expect(row.outcome).toBe('failed');
    expect(row.reason_code).toBe('credential_grant');
  });
});
