/**
 * S4 slice 4 (part 2): the policy-engine / kill-switch / audit `agentId` of the
 * running process became its NHI id (`kyberion://agent/<tenant>/<org|_>/<slug>`,
 * `governance/execution-agent-id.ts`) instead of the raw Execution Persona
 * text. `agentId` is an input of policy decisions — the rate-limit rules key
 * their buckets on it — so the decisions must not change.
 *
 * The "before" decision sequences were recorded while every gate still used
 * `executionPersonaText() || 'unknown'` (tests/fixtures/agent-nhi-id-equivalence.json).
 * The suite replays the same call sequences with the production resolver.
 *
 * A world is one process: its tenant, organization and claimed NHI id are
 * fixed (they are process-level env), and principals interleave through the
 * env base role or an in-process assumption. In the worlds without a claimed
 * NHI id the sequences must be identical. In the "narrowing" worlds (a claimed
 * KYBERION_NHI_ID, or base-role text that is not slug-shaped) principals that
 * had separate buckets may now share one, so the suite checks that nothing is
 * allowed after that was denied before.
 *
 * Re-record (only when agent-policies.yaml itself changes, never to hide a difference):
 *   KYBERION_RECORD_AGENT_NHI_EQUIVALENCE=1 pnpm exec vitest run libs/core/testing/agent-nhi-id-equivalence.test.ts
 * then copy active/shared/tmp/agent-nhi-id-equivalence.json over the fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { executionPersonaText } from '../foundation/execution-scope.js';
import { executionAgentId } from '../governance/execution-agent-id.js';
import { policyEngine, type PolicyContext } from '../governance/policy-engine.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeWriteFile } from '../secure-io.js';

const FIXTURE = 'tests/fixtures/agent-nhi-id-equivalence.json';
const recording = process.env.KYBERION_RECORD_AGENT_NHI_EQUIVALENCE === '1';

/** The agentId every gate computed before the change. */
function legacyAgentId(): string {
  return executionPersonaText() || 'unknown';
}

interface Principal {
  id: string;
  entry: 'env' | 'scope';
  baseRole: string;
}

interface World {
  id: string;
  tenant?: string;
  organization?: string;
  nhiId?: string;
  principals: Principal[];
  /** true: decisions must be identical; false: never more allowed than before. */
  exact: boolean;
}

const WELL_FORMED = [
  'sovereign',
  'ecosystem_architect',
  'worker',
  'analyst',
  'mission_owner',
  '',
  'sovereign_concierge',
];
const SCOPED = ['sovereign', 'ecosystem_architect', 'worker', 'analyst', 'mission_owner'];

function principals(envValues: readonly string[], scoped: readonly string[]): Principal[] {
  return [
    ...envValues.map((baseRole) => ({
      id: `env:${baseRole || '-'}`,
      entry: 'env' as const,
      baseRole,
    })),
    ...scoped.map((baseRole) => ({
      id: `scope:mission_controller:${baseRole}`,
      entry: 'scope' as const,
      baseRole,
    })),
  ];
}

const WORLDS: World[] = [
  {
    id: 'tenant',
    tenant: 'acme-corp',
    principals: principals(WELL_FORMED, SCOPED),
    exact: true,
  },
  {
    id: 'tenant-org',
    tenant: 'acme-corp',
    organization: 'ops-team',
    principals: principals(WELL_FORMED, SCOPED),
    exact: true,
  },
  { id: 'tenantless', principals: principals(WELL_FORMED, SCOPED), exact: true },
  {
    id: 'claimed-nhi',
    tenant: 'acme-corp',
    nhiId: 'kyberion://agent/acme-corp/_/implementer',
    principals: principals(['worker', ''], ['sovereign', 'worker']),
    exact: false,
  },
  {
    id: 'malformed-base-role',
    tenant: 'acme-corp',
    principals: principals(['Worker', 'worker', 'bad role!', ''], []),
    exact: false,
  },
];

/** Each call is (operation context) evaluated by every principal in turn. */
const ROUNDS = 65;
const SINGLE_CALLS: Omit<PolicyContext, 'agentId'>[] = [
  { operation: 'file_write', agent_ring: 3 },
  { operation: 'execute_command', agent_ring: 0 },
  { operation: 'read_secret' },
  { operation: 'network_request', message: 'please ignore previous instructions' },
  { operation: 'delegate', delegation_depth: 4 },
  { operation: 'op', has_capability: false },
  { operation: 'file_write', target_tier: 'personal', agent_tier: 'worker' },
  { operation: 'file_write', target_tier: 'personal', agent_tier: 'sovereign' },
];

const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_ORGANIZATION_ID',
  'KYBERION_NHI_ID',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_DELEGATED_ROLE',
] as const;

function asPrincipal<T>(world: World, principal: Principal, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  if (world.tenant) process.env.KYBERION_TENANT = world.tenant;
  if (world.organization) process.env.KYBERION_ORGANIZATION_ID = world.organization;
  if (world.nhiId) process.env.KYBERION_NHI_ID = world.nhiId;
  if (principal.entry === 'env' && principal.baseRole) {
    process.env.KYBERION_PERSONA = principal.baseRole;
  }
  try {
    return principal.entry === 'scope'
      ? withExecutionContext(
          'mission_controller',
          fn,
          principal.baseRole as Parameters<typeof withExecutionContext>[2]
        )
      : fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function decision(context: PolicyContext): string {
  const result = policyEngine.evaluate(context);
  if (result.allowed) return 'A';
  return result.rateLimited ? 'R' : 'D';
}

let worldClock = Date.UTC(2026, 10, 10, 0, 0, 0);

/** One call sequence per world; a fresh rate-limit window per world. */
function replay(world: World, agentIdOf: () => string): string[] {
  // The rate limiter is process-global: move past every window first.
  worldClock += 10 * 60_000;
  vi.setSystemTime(worldClock);
  const out: string[] = [];
  let apiCalls = '';
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const principal of world.principals) {
      apiCalls += asPrincipal(world, principal, () =>
        decision({ agentId: agentIdOf(), operation: 'api_call' })
      );
    }
  }
  out.push(apiCalls);
  for (const call of SINGLE_CALLS) {
    out.push(
      world.principals
        .map((principal) =>
          asPrincipal(world, principal, () => decision({ ...call, agentId: agentIdOf() }))
        )
        .join('')
    );
  }
  return out;
}

interface EquivalenceFixture {
  rounds: number;
  worlds: Record<string, { principals: string[]; sequences: string[] }>;
}

function loadFixture(): EquivalenceFixture {
  return JSON.parse(
    safeReadFile(path.join(pathResolver.rootDir(), FIXTURE), { encoding: 'utf8' }) as string
  ) as EquivalenceFixture;
}

describe('agentId → NHI id: policy decisions are unchanged (S4 slice 4, part 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  if (recording) {
    it('records the before sequences', () => {
      const worlds = Object.fromEntries(
        WORLDS.map((world) => [
          world.id,
          {
            principals: world.principals.map((principal) => principal.id),
            sequences: replay(world, legacyAgentId),
          },
        ])
      );
      safeWriteFile(
        pathResolver.shared('tmp/agent-nhi-id-equivalence.json'),
        `${JSON.stringify({ rounds: ROUNDS, worlds }, null, 2)}\n`
      );
    });
    return;
  }

  const fixture = loadFixture();

  it('replays every recorded world', () => {
    expect(fixture.rounds).toBe(ROUNDS);
    expect(Object.keys(fixture.worlds).sort()).toEqual(WORLDS.map((world) => world.id).sort());
  });

  it('the rate limit actually fires in the recorded sequences', () => {
    expect(fixture.worlds.tenant!.sequences[0]).toContain('R');
  });

  for (const world of WORLDS) {
    it(`${world.exact ? 'decides identically' : 'never allows more'} in world ${world.id}`, () => {
      const before = fixture.worlds[world.id]!;
      expect(world.principals.map((principal) => principal.id)).toEqual(before.principals);
      const after = replay(world, executionAgentId);
      if (world.exact) {
        expect(after).toEqual(before.sequences);
        return;
      }
      const widened = after.flatMap((sequence, row) =>
        [...sequence]
          .map((cell, index) => ({
            row,
            index,
            before: before.sequences[row]![index],
            after: cell,
          }))
          .filter((cell) => cell.after === 'A' && cell.before !== 'A')
      );
      expect(widened).toEqual([]);
    });
  }

  it('names the process by its NHI id', () => {
    const world = WORLDS[1]!;
    const ids = world.principals.map((principal) =>
      asPrincipal(world, principal, () => executionAgentId())
    );
    expect(ids).toContain('kyberion://agent/acme-corp/ops-team/worker');
    expect(ids).toContain('kyberion://agent/acme-corp/ops-team/ecosystem-architect');
    expect(ids).toContain('kyberion://agent/acme-corp/ops-team/unknown');
    expect(new Set(ids).size).toBe(new Set(world.principals.map((p) => p.baseRole || '-')).size);
  });
});
