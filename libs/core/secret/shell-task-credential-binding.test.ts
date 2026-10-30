import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
import {
  withTaskCredentialBinding,
  resolveTaskCredential,
} from '../foundation/credential-binding.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { ShellSecretResolver } from './secret-resolver.js';
import {
  bindShellTaskCredentials,
  TASK_BINDING_SECRET_KEY,
} from './shell-task-credential-binding.js';

type FixtureScope = { tier?: string; tenant_slug: string; mission_id: string; task_id: string };
type FixtureItem = {
  item_id: string;
  status: string;
  context: FixtureScope;
  lease_id: string;
  current_attempt_id: string;
  claimed_by_peer_id: string;
  attempts: Array<{
    attempt_id: string;
    run_id: string;
    lease_id: string;
    status: string;
    actor_peer_id: string;
  }>;
};
type FixtureActor = {
  actor: { kind: string; id: string };
  scope: FixtureScope;
  provenance: string;
};
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  item: {} as FixtureItem,
  leases: [] as Array<{ lease_id: string; item_id: string; holder_peer_id: string }>,
  actor: {} as FixtureActor,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
      String(args[1]).includes('__KYBERION_TASK_BINDING__')
        ? mocks.exec(...args)
        : actual.execFileSync(...args),
  };
});
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: (id: string) => (id === 'WI-bound' ? mocks.item : undefined),
  listActiveWorkLeases: () => mocks.leases,
}));
vi.mock('../actor-context.js', () => ({ currentActor: () => mocks.actor }));

const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'binding-tenant',
  mission_id: 'MSN-BINDING',
  task_id: 'task-a',
};
const actorId = 'kyberion://agent/binding-org/worker';
const input = { scope, workItemId: 'WI-bound' };
const root = pathResolver.rootResolve(
  `active/shared/tmp/confidential/${scope.tenant_slug}/vitest-binding-${randomUUID()}`
);
const home = `${root}/home`;
const tenant = <T>(run: () => T) =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', scope.tenant_slug);
const scoped = <T>(run: () => T) =>
  tenant(() =>
    withScopeEnvelope(
      mintScopeEnvelope({
        env: {
          KYBERION_TIER: scope.tier,
          KYBERION_TENANT: scope.tenant_slug,
          MISSION_ID: scope.mission_id,
          KYBERION_TASK_ID: scope.task_id,
        },
        policy: { purpose: 'credential binding test' },
      }),
      run
    )
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KYBERION_TIER', 'confidential');
  mocks.item = {
    item_id: input.workItemId,
    status: 'in_progress',
    context: { ...scope },
    lease_id: 'lease-a',
    current_attempt_id: 'run-a',
    claimed_by_peer_id: actorId,
    attempts: [
      {
        attempt_id: 'attempt-a',
        run_id: 'run-a',
        lease_id: 'lease-a',
        status: 'running',
        actor_peer_id: actorId,
      },
    ],
  };
  mocks.leases = [{ lease_id: 'lease-a', item_id: input.workItemId, holder_peer_id: actorId }];
  mocks.actor = { actor: { kind: 'agent', id: actorId }, scope: { ...scope }, provenance: 'claim' };
  tenant(() => safeMkdir(home, { recursive: true }));
});
afterEach(() => {
  tenant(() => safeRmSync(root, { recursive: true, force: true }));
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});

describe('ShellSecretResolver task credential adapter', () => {
  it('passes versioned claim metadata on stdin and binds only explicit tenant credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'operator-secret-never-inherited');
    mocks.exec.mockReturnValue(
      JSON.stringify({
        version: 1,
        secrets: { TENANT_KEY: 'tenant-value' },
        providerEnvironments: { codex: { HOME: home } },
      })
    );
    await scoped(async () => {
      const binding = await new ShellSecretResolver({
        command: 'resolver {{key}} {{scope}}',
      }).bindTask(input);
      expect(binding).toMatchObject({
        tenantSlug: scope.tenant_slug,
        missionId: scope.mission_id,
        taskId: scope.task_id,
      });
      withTaskCredentialBinding(binding!, () => {
        expect(resolveTaskCredential('TENANT_KEY')).toBe('tenant-value');
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBeNull();
      });
    });
    expect(mocks.exec).toHaveBeenCalledOnce();
    const [shell, args, options] = mocks.exec.mock.calls[0]!;
    expect(args).toEqual(['-c', `resolver ${TASK_BINDING_SECRET_KEY} ${scope.tenant_slug}`]);
    expect(typeof shell).toBe('string');
    expect(JSON.parse(options.input)).toEqual({ version: 1, scope, workItemId: input.workItemId });
    expect(options.maxBuffer).toBe(128 * 1024);
    expect(JSON.stringify(args)).not.toContain('tenant-value');
  });

  it.each(['tenant', 'task', 'actor', 'attempt', 'lease'])(
    'refuses %s drift before consulting secrets',
    async (kind) => {
      if (kind === 'tenant') mocks.item.context.tenant_slug = 'foreign';
      if (kind === 'task') mocks.item.context.task_id = 'task-b';
      if (kind === 'actor') mocks.actor.actor.id = 'kyberion://agent/binding-org/other';
      if (kind === 'attempt') mocks.item.attempts[0].status = 'released';
      if (kind === 'lease') mocks.leases = [];
      await expect(
        scoped(() => new ShellSecretResolver({ command: 'resolver' }).bindTask(input))
      ).rejects.toThrow('CREDENTIAL_BINDING_UNAVAILABLE');
      expect(mocks.exec).not.toHaveBeenCalled();
    }
  );

  it('revalidates the current claim after resolver execution', async () => {
    const resolve = vi.fn(() => {
      mocks.item.current_attempt_id = 'attempt-b';
      return JSON.stringify({ version: 1, secrets: { KEY: 'not-logged' } });
    });
    await expect(scoped(() => bindShellTaskCredentials(input, resolve))).rejects.toThrow(
      'CREDENTIAL_BINDING_UNAVAILABLE'
    );
  });

  it.each([
    { version: 1, secrets: { KEY: 42 } },
    { version: 1, secrets: { KEY: `secret${String.fromCharCode(0)}value` } },
    { version: 1, secrets: { KEY: 'secret' }, tenantSlug: 'foreign' },
    { version: 2, secrets: {} },
    { version: 1, secrets: {}, providerEnvironments: { codex: { HOME: '/operator/home' } } },
    {
      version: 1,
      secrets: {},
      providerEnvironments: { codex: { HOME: home, CODEX_HOME: '/operator/codex' } },
    },
  ])('rejects invalid response structure or provider HOME %#', async (response) => {
    await expect(
      scoped(() => bindShellTaskCredentials(input, () => JSON.stringify(response)))
    ).rejects.toThrow(/CREDENTIAL_/);
  });

  it('keeps a missing response unbound and an empty response binding final', async () => {
    await scoped(async () => {
      expect(await bindShellTaskCredentials(input, () => null)).toBeNull();
      const binding = await bindShellTaskCredentials(input, () => '{"version":1,"secrets":{}}');
      withTaskCredentialBinding(binding!, () =>
        expect(resolveTaskCredential('MISSING')).toBeNull()
      );
    });
  });

  it.each([
    'not-json-secret-value',
    '{"version":1,"secrets":{"__proto__":"bad"}}',
    'x'.repeat(128 * 1024 + 1),
  ])(
    'rejects malformed, prototype-bearing or oversized responses without disclosing content %#',
    async (raw) => {
      await expect(scoped(() => bindShellTaskCredentials(input, () => raw))).rejects.toThrow(
        '[CREDENTIAL_BINDING_UNAVAILABLE] Task credential admission failed'
      );
    }
  );
});
