import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { computeBudgetUsage } from '../governance/org-budget-governor.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';
import { getUsageAttribution, withUsageAttribution } from '../usage-accounting.js';
import type {
  ClaimWorkItemInput,
  ReleaseWorkItemInput,
  WorkItem,
} from '../workforce/work-coordination-types.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import {
  DOT_EXECUTOR_CROSS_TENANT_DENIAL,
  DOT_EXECUTOR_MAX_ATTEMPTS,
  DOT_EXECUTOR_MISSING_SHAPE_GUIDANCE,
  DOT_EXECUTOR_MISSION_GUIDANCE,
  DOT_EXECUTOR_TASK_SESSION_GUIDANCE,
  DotExecutorPreEffectError,
  dotExecutorStatusSection,
  reapStrandedDotWorkItems,
  resetDotExecutorDenialAuditForTests,
  DOT_EXECUTOR_READ_ONLY_PREFIX,
  dotWorkResultsPromptLines,
  executeDotWorkItem,
  listClaimableDotWorkItems,
  readDotKrSnapshot,
  runDotExecutorSweep,
  type DotExecutorDeps,
  type DotExecutorPorts,
} from './dot-executor.js';
import { DOT_PROMPT_SECTIONS, DOT_STATUS_SECTIONS } from './dot-extension-registry.js';
import { DOT_SIGNAL_LEDGER_PATH } from './dot-feedback.js';
import type { DotInboxEntryInput } from './dot-inbox.js';
import { DOT_EXECUTOR_REPORT_SOURCE } from './dot-runtime.js';
import {
  DOT_KR_LEDGER_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
} from './dot-state-paths.js';
import './dot-extension-bootstrap.js';

const TEST_ROOT = 'active/shared/tmp/dot-executor-tests';
const NOW = new Date('2026-10-04T10:00:00Z');

function charter(overrides: Partial<DotCharter> = {}): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'ops',
    version: '1.0.0',
    title: 'Ops dot',
    purpose: 'Keep operations green.',
    status: 'active',
    scope: { tier: 'public' },
    goal: {
      statement: 'green',
      budget: { wall_clock_ms_per_wake: 120_000, max_turns_per_wake: 4 },
    },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['task_session', 'pipeline', 'direct_reply', 'mission'],
      allowed_pipelines: ['pipelines/ok.json'],
    },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-ops' },
    ...overrides,
  };
}

function item(id: string, metadata: Record<string, unknown>, extra: Partial<WorkItem> = {}) {
  return {
    item_id: id,
    title: `Item ${id}`,
    description: `Do ${id}`,
    status: 'ready',
    priority: 'normal',
    version: 1,
    created_at: `2026-10-04T09:0${id.slice(-1)}:00Z`,
    updated_at: '2026-10-04T09:00:00Z',
    metadata: {
      dot_id: 'ops',
      action_ref: `dact-${id}`,
      requested_work_shape: 'task_session',
      ...metadata,
    },
    ...extra,
  } as unknown as WorkItem;
}

type Dep<K extends keyof DotExecutorDeps> = NonNullable<DotExecutorDeps[K]>;
type ReapOptions = Parameters<Dep<'reap'>>[0];

interface Harness {
  deps: DotExecutorDeps;
  claims: ClaimWorkItemInput[];
  releases: ReleaseWorkItemInput[];
  inbox: DotInboxEntryInput[];
  audits: Array<Record<string, unknown>>;
  tokens: Array<[string, number]>;
}

function harness(items: WorkItem[] = [], attempts = 1): Harness {
  const h: Harness = { claims: [], releases: [], inbox: [], audits: [], tokens: [], deps: {} };
  h.deps = {
    rootDir: TEST_ROOT,
    now: () => NOW,
    listItems: () => items,
    claim: (input) => {
      h.claims.push(input);
      const found = items.find((entry) => entry.item_id === input.itemId)!;
      return {
        item: {
          ...found,
          status: 'in_progress',
          current_attempt_id: 'run-1',
          attempts: Array.from({ length: attempts }, (_, i) => ({ run_id: `run-${i}` })),
        } as unknown as WorkItem,
        lease: { lease_id: 'lease-1' } as unknown as ReturnType<Dep<'claim'>>['lease'],
      };
    },
    release: (input) => {
      h.releases.push(input);
      return { item: {} as WorkItem, lease: {} as ReturnType<Dep<'release'>>['lease'] };
    },
    renew: vi.fn() as unknown as Dep<'renew'>,
    throttle: () => 'normal',
    tokenCapReached: () => false,
    reap: () => ({ expired: [], recovered: [], parked: [], replayed: [] }),
    appendInbox: (input) => void h.inbox.push(input),
    audit: (entry) => void h.audits.push(entry as Record<string, unknown>),
    recordTokens: (dotId, tokens) => void h.tokens.push([dotId, tokens]),
  };
  return h;
}

function ports(overrides: Partial<DotExecutorPorts> = {}): DotExecutorPorts {
  return {
    runGoalTurn: vi.fn(async () => ({
      turnsRun: 2,
      finalState: 'complete',
      goal: { budgetStats: { tokensUsed: 900 } },
      finalText: 'Ticked 3 overdue operations.',
    })),
    delegateText: vi.fn(async () => 'Found 2 stale runbooks; update them.'),
    runPipeline: vi.fn(async () => ({
      status: 'succeeded' as const,
      summary: '2 step(s) succeeded',
    })),
    ...overrides,
  };
}

function results(c: DotCharter): DotWorkResultRow[] {
  return readJsonLines<DotWorkResultRow>(
    path.join(TEST_ROOT, dotStatePath(c, DOT_WORK_RESULTS_FILE))
  );
}

afterEach(() => {
  vi.useRealTimers();
  resetDotExecutorDenialAuditForTests();
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('listClaimableDotWorkItems', () => {
  it('returns ready, unleased items addressed to the dot (own or handed to it), oldest first', () => {
    const items = [
      item('w3', {}),
      item('w1', {}),
      item('w2', { dot_id: 'other' }),
      item('w4', {}, { lease_id: 'lease-x' }),
      item('w5', {}, { status: 'done' }),
      item('w6', { handoff_to: 'peer' }),
      item('w7', { dot_id: 'other', handoff_to: 'ops' }),
    ];
    const ids = listClaimableDotWorkItems(charter(), { listItems: () => items }).map(
      (i) => i.item_id
    );
    expect(ids).toEqual(['w1', 'w3', 'w7']);
  });

  it('reads protected terminal evidence in the charter scope and restores the outer scope', () => {
    const c = charter({
      scope: { tier: 'confidential', tenant_slug: 'acme' },
      authority: { authority_role: 'organization_operator' },
    });
    const fixtureRoot = path.resolve(TEST_ROOT);
    const evidenceRoot = path.join(fixtureRoot, 'knowledge/confidential/acme/executor');
    const file = path.join(evidenceRoot, dotStatePath(c, DOT_WORK_RESULTS_FILE));
    safeMkdir(path.dirname(file), { recursive: true });
    appendJsonLine(file, {
      dot_id: c.dot_id,
      work_item_id: 'w1',
      action_ref: 'dact-w1',
      status: 'done',
      mode: 'pipeline',
      summary: 'already applied',
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
    });
    // Treat the fixture as the repository root, so secure-io evaluates a real
    // confidential path rather than the globally allowed active/shared/tmp prefix.
    const root = vi.spyOn(pathResolver, 'rootDir').mockReturnValue(fixtureRoot);
    try {
      withExecutionContext(
        'organization_operator',
        () => {
          expect(() => safeReadFile(file)).toThrow(/tenant.scope_violation/);
          expect(
            listClaimableDotWorkItems(c, {
              rootDir: evidenceRoot,
              listItems: () => [item('w1', {}, { context: { tenant_slug: 'acme' } })],
            })
          ).toEqual([]);
          expect(currentExecutionScope()?.tenantSlug).toBe('other-tenant');
        },
        undefined,
        'other-tenant'
      );
    } finally {
      root.mockRestore();
    }
  });

  it('fails closed when the charter role cannot read protected execution evidence', async () => {
    const c = charter({ scope: { tier: 'confidential', tenant_slug: 'acme' } });
    const fixtureRoot = path.resolve(TEST_ROOT);
    const evidenceRoot = path.join(fixtureRoot, 'knowledge/confidential/acme/executor');
    const file = path.join(evidenceRoot, dotStatePath(c, DOT_WORK_RESULTS_FILE));
    safeMkdir(path.dirname(file), { recursive: true });
    appendJsonLine(file, { dot_id: c.dot_id, work_item_id: 'w1', status: 'done' });
    const h = harness([item('w1', {}, { context: { tenant_slug: 'acme' } })]);
    h.deps.rootDir = evidenceRoot;
    const p = ports();
    const root = vi.spyOn(pathResolver, 'rootDir').mockReturnValue(fixtureRoot);
    try {
      expect(await runDotExecutorSweep([{ path: 'dots/ops.json', charter: c }], p, h.deps)).toEqual(
        []
      );
      expect(h.claims).toEqual([]);
      expect(p.runGoalTurn).not.toHaveBeenCalled();
    } finally {
      root.mockRestore();
    }
  });
});

describe('executeDotWorkItem', () => {
  it.each(['tool', 'delegated'] as const)(
    'attributes %s executor usage to the dot without counting SDK tokens twice',
    async (mode) => {
      const c = charter({
        scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'o1' },
      });
      const target = item(
        'w1',
        { requested_work_shape: 'direct_reply' },
        { context: { tenant_slug: 'acme' } }
      );
      const h = harness([target]);
      h.deps.recordTokens = undefined; // Exercise the real persisted dot token ledger.
      const sdkRows: Array<Record<string, unknown>> = [];
      const meter = async (tokens: number) => {
        await Promise.resolve();
        const attribution = getUsageAttribution();
        expect(attribution).toEqual({
          actor_id: 'dot:ops',
          accounting_id: 'run-1',
          scope: {
            tier: 'confidential',
            tenant_slug: 'acme',
            organization_id: 'o1',
            scope_kind: 'organization',
          },
        });
        sdkRows.push({
          component: 'anthropic-sdk',
          agent: 'anthropic-sdk',
          timestamp: NOW.toISOString(),
          ...attribution,
          usage: { prompt_tokens: tokens },
          cost_usd: 0.5,
        });
      };
      const p = ports({
        goalMode: () => mode,
        runGoalTurn: async () => {
          await meter(900);
          return {
            turnsRun: 1,
            finalState: 'complete',
            goal: { budgetStats: { tokensUsed: 900 } },
            finalText: 'answer',
          };
        },
        delegateText: async (prompt) => {
          await meter(Math.ceil((prompt.length + 'answer'.length) / 3));
          return 'answer';
        },
      });
      expect(getUsageAttribution()).toBeUndefined();
      const row = await withUsageAttribution(
        { actor_id: 'outer-owner', scope: { tier: 'public' } },
        async () => {
          const result = await executeDotWorkItem(c, target, p, h.deps);
          expect(getUsageAttribution()?.actor_id).toBe('outer-owner');
          return result;
        }
      );
      expect(getUsageAttribution()).toBeUndefined();
      const usage = computeBudgetUsage(
        { tenant_slug: 'acme', organization_id: 'o1' },
        {
          rootDir: TEST_ROOT,
          now: () => NOW,
          listCharters: () => [{ charter: c }],
          readMetricsHistory: () => sdkRows,
          readGenerationUnits: () => 0,
        }
      );
      expect(usage.tokens).toBe(row.tokens_used);
      expect(usage.by_source).toEqual({ dots: row.tokens_used, missions: 0, generation: 0 });
      expect(usage.cost_usd).toBe(0.5);
    }
  );

  it('leaves pipeline SDK usage provider-owned because pipelines do not populate the dot ledger', async () => {
    const target = item('w1', {
      requested_work_shape: 'pipeline',
      pipeline_ref: 'pipelines/ok.json',
    });
    const h = harness([target]);
    const p = ports({
      runPipeline: async () => {
        await Promise.resolve();
        expect(getUsageAttribution()).toBeUndefined();
        return { status: 'succeeded', summary: 'ok' };
      },
    });
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(row.tokens_used).toBeUndefined();
    expect(h.tokens).toEqual([]);
    expect(getUsageAttribution()).toBeUndefined();
  });

  it('snapshots signal health at claim time, before the action can change it', async () => {
    const c = charter();
    const ledger = path.join(TEST_ROOT, DOT_SIGNAL_LEDGER_PATH);
    safeMkdir(path.dirname(ledger), { recursive: true });
    const signal = (healthy: boolean, measured_at: string, dot_id = 'ops') =>
      appendJsonLine(ledger, { dot_id, signal: 'api', healthy, measured_at });
    signal(true, '2026-10-04T08:00:00Z');
    signal(false, '2026-10-04T09:00:00Z');
    signal(true, '2026-10-04T09:30:00Z', 'other');
    const target = item('w1', {});
    const h = harness([target]);
    const p = ports({
      runGoalTurn: vi.fn(async () => {
        // The action fixes the signal while it runs.
        signal(true, '2026-10-04T10:00:00Z');
        return {
          turnsRun: 1,
          finalState: 'complete',
          goal: { budgetStats: { tokensUsed: 10 } },
          finalText: 'Fixed the api.',
        };
      }) as unknown as DotExecutorPorts['runGoalTurn'],
    });
    const row = await executeDotWorkItem(c, target, p, h.deps);
    expect(row).toMatchObject({ status: 'done', signal_snapshot: { api: 0 } });
  });

  it('runs task_session work as a bounded goal turn under the charter role and closes it', async () => {
    const c = charter();
    const file = path.join(TEST_ROOT, dotStatePath(c, DOT_KR_LEDGER_FILE));
    safeMkdir(path.dirname(file), { recursive: true });
    appendJsonLine(file, {
      scope: 'dot',
      dot_id: 'ops',
      kr_id: 'overdue',
      value: 5,
      progress: 0,
      measured_at: '2026-10-04T08:00:00Z',
    });
    appendJsonLine(file, {
      scope: 'dot',
      dot_id: 'ops',
      kr_id: 'overdue',
      value: 3,
      progress: 0,
      measured_at: '2026-10-04T09:00:00Z',
    });
    appendJsonLine(file, {
      scope: 'dot',
      dot_id: 'other',
      kr_id: 'x',
      value: 9,
      progress: 0,
      measured_at: '2026-10-04T09:00:00Z',
    });
    const target = item('w1', { target: 'service:ops', intent: 'apply' });
    const h = harness([target]);
    const p = ports();
    const row = await executeDotWorkItem(c, target, p, h.deps);

    expect(h.claims[0]).toMatchObject({
      itemId: 'w1',
      actorPeerId: 'dot:ops',
      idempotencyKey: 'dact-w1',
      expectedVersion: 1,
      ttlMs: 180_000,
    });
    expect(p.runGoalTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolRole: 'infrastructure_sentinel',
        maxTurns: 4,
        budget: { wallClockBudgetMs: 120_000, turnBudget: 4 },
        objective: expect.stringContaining('Target: service:ops; intent: apply'),
      }),
      expect.any(AbortSignal)
    );
    expect(h.releases[0]).toMatchObject({
      itemId: 'w1',
      leaseId: 'lease-1',
      actorPeerId: 'dot:ops',
      nextStatus: 'done',
      summary: 'Ticked 3 overdue operations.',
    });
    expect(row).toMatchObject({
      status: 'done',
      mode: 'goal_turn',
      tokens_used: 900,
      attempt_id: 'run-1',
      kr_snapshot: { overdue: 3 },
    });
    expect(results(c)).toEqual([row]);
    expect(h.tokens).toEqual([['ops', 900]]);
    expect(h.audits[0]).toMatchObject({
      agentId: 'dot:ops',
      operation: 'dot_work_item_execute',
      result: 'completed',
    });
    expect(h.inbox[0]).toMatchObject({
      dot_id: 'ops',
      source: DOT_EXECUTOR_REPORT_SOURCE,
      payload: {
        report_from: DOT_EXECUTOR_REPORT_SOURCE,
        work_item_id: 'w1',
        action_ref: 'dact-w1',
        status: 'done',
      },
    });
  });

  it('falls back to one advisory delegated turn without a live tool backend', async () => {
    const target = item('w1', { requested_work_shape: 'direct_reply' });
    const h = harness([target]);
    const p = ports({ goalMode: () => 'delegated' });
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(p.runGoalTurn).not.toHaveBeenCalled();
    expect(p.delegateText).toHaveBeenCalledWith(
      expect.stringContaining('read-only'),
      120_000,
      expect.any(AbortSignal)
    );
    expect(row.mode).toBe('delegated');
    expect(row.summary.startsWith(DOT_EXECUTOR_READ_ONLY_PREFIX)).toBe(true);
  });

  it('runs an allowed pipeline and blocks one outside allowed_pipelines', async () => {
    const ok = item('w1', { requested_work_shape: 'pipeline', pipeline_ref: 'pipelines/ok.json' });
    const bad = item('w2', {
      requested_work_shape: 'pipeline',
      pipeline_ref: 'pipelines/evil.json',
    });
    const h = harness([ok, bad]);
    const p = ports();
    const done = await executeDotWorkItem(charter(), ok, p, h.deps);
    expect(p.runPipeline).toHaveBeenCalledWith(
      'pipelines/ok.json',
      expect.objectContaining({ dot_id: 'ops', work_item_id: 'w1', action_ref: 'dact-w1' }),
      expect.any(AbortSignal)
    );
    expect(done).toMatchObject({ status: 'done', mode: 'pipeline' });
    const blocked = await executeDotWorkItem(charter(), bad, p, h.deps);
    expect(p.runPipeline).toHaveBeenCalledTimes(1);
    expect(blocked).toMatchObject({ status: 'blocked', mode: 'escalated' });
    expect(blocked.summary).toContain('not in charter authority.allowed_pipelines');
    // Escalations release terminal (archived) so they free the delegation slot.
    expect(h.releases[1].nextStatus).toBe('archived');
    expect(h.releases[1].metadata).toMatchObject({
      dot_executor: { status: 'blocked', mode: 'escalated', escalated: true },
    });
    expect(h.audits[1].result).toBe('denied');
  });

  it('never starts a mission: mission-shaped work is blocked with guidance', async () => {
    const target = item('w1', { requested_work_shape: 'mission' });
    const h = harness([target]);
    const p = ports();
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(p.runGoalTurn).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      status: 'blocked',
      mode: 'escalated',
      summary: DOT_EXECUTOR_MISSION_GUIDANCE,
    });
    expect(h.inbox).toHaveLength(1);
  });

  it.each(['tool', 'delegated'] as const)(
    'quarantines a read-only-labelled %s failure because the port may have produced effects',
    async (mode) => {
      const target = item('w1', { requested_work_shape: 'direct_reply' });
      const failing = ports({
        goalMode: () => mode,
        runGoalTurn: vi.fn(async () => {
          throw new Error('provider down');
        }),
        delegateText: vi.fn(async () => {
          throw new Error('provider down');
        }),
      });
      const first = harness([target], 1);
      const row = await executeDotWorkItem(charter(), target, failing, first.deps);
      expect(row).toMatchObject({
        status: 'blocked',
        summary: expect.stringContaining('provider down'),
      });
      expect(first.releases[0].nextStatus).toBe('archived');
      expect(first.inbox).toHaveLength(1);
      const last = harness([target], 3);
      expect((await executeDotWorkItem(charter(), target, failing, last.deps)).status).toBe(
        'skipped'
      );
      expect(last.releases).toHaveLength(0);
      expect(mode === 'tool' ? failing.runGoalTurn : failing.delegateText).toHaveBeenCalledTimes(1);
    }
  );

  it('quarantines an incomplete read-only goal and preserves an explicit blocked reason', async () => {
    const target = item('w1', { requested_work_shape: 'direct_reply' });
    const paused = ports({
      runGoalTurn: vi.fn(async () => ({ turnsRun: 4, finalState: 'paused', goal: {} })),
    });
    expect(
      (await executeDotWorkItem(charter(), target, paused, harness([target]).deps)).status
    ).toBe('blocked');
    const blocked = ports({
      runGoalTurn: vi.fn(async () => ({
        turnsRun: 1,
        finalState: 'blocked',
        goal: {},
        finalText: 'needs creds',
      })),
    });
    const other = item('w2', { requested_work_shape: 'direct_reply' });
    const row = await executeDotWorkItem(charter(), other, blocked, harness([other]).deps);
    expect(row).toMatchObject({
      status: 'blocked',
      summary: expect.stringContaining('needs creds'),
    });
  });

  it('quarantines an effect-capable goal that throws after a possible effect', async () => {
    const target = item('w1', {});
    const h = harness([target]);
    let effects = 0;
    const p = ports({
      runGoalTurn: vi.fn(async () => {
        effects += 1;
        throw new Error('lost response after applying change');
      }),
    });
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(row.status).toBe('blocked');
    expect(row.summary).toContain('partial effects cannot be ruled out');
    expect(h.releases[0].nextStatus).toBe('archived');
    expect((await executeDotWorkItem(charter(), target, p, h.deps)).status).toBe('skipped');
    expect(effects).toBe(1);
  });

  it('keeps tenant prose out of the shared WorkItem store, audit chain and inbox', async () => {
    const c = charter({
      scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'acme-org' },
    });
    const target = item('w1', {}, { context: { tenant_slug: 'acme' } } as Partial<WorkItem>);
    const h = harness([target]);
    await executeDotWorkItem(c, target, ports(), h.deps);
    expect(h.releases[0].summary).not.toContain('Ticked');
    expect(h.audits[0].metadata.summary).toBeUndefined();
    expect(h.audits[0].tenantSlug).toBe('acme');
    expect(h.inbox[0].text).toBe('WorkItem w1 done');
    const file = dotStatePath(c, DOT_WORK_RESULTS_FILE);
    expect(file).toContain('acme');
    expect(results(c)[0].summary).toBe('Ticked 3 overdue operations.');
  });

  it('returns an unpersisted skipped row when the claim conflicts or no backend can run it', async () => {
    const target = item('w1', {});
    const h = harness([target]);
    h.deps.claim = () => {
      throw new Error('item is already leased: w1');
    };
    const row = await executeDotWorkItem(charter(), target, ports(), h.deps);
    expect(row.status).toBe('skipped');
    const none = await executeDotWorkItem(
      charter(),
      target,
      ports({ goalMode: () => ({ unavailable: 'stub only' }) }),
      harness([target]).deps
    );
    expect(none).toMatchObject({ status: 'skipped', summary: 'no backend: stub only' });
    expect(results(charter())).toEqual([]);
  });
});

describe('runDotExecutorSweep', () => {
  it('takes at most one item per active dot and skips paused or hard-throttled dots', async () => {
    const items = [
      item('w1', {}),
      item('w2', {}),
      item('w3', { dot_id: 'paused' }),
      item('w4', { dot_id: 'broke' }),
    ];
    const h = harness(items);
    h.deps.throttle = (c) => (c.dot_id === 'broke' ? 'hard' : 'soft');
    const loaded = (c: DotCharter): LoadedDotCharter => ({
      path: `dots/${c.dot_id}.json`,
      charter: c,
    });
    const rows = await runDotExecutorSweep(
      [
        loaded(charter()),
        loaded(charter({ dot_id: 'paused', status: 'paused' })),
        loaded(charter({ dot_id: 'broke' })),
      ],
      ports(),
      h.deps
    );
    expect(rows.map((r) => r.work_item_id)).toEqual(['w1']);
    expect(h.claims.map((c) => c.itemId)).toEqual(['w1']);
  });

  it('fails open when the budget governor throws', async () => {
    const h = harness([item('w1', {})]);
    h.deps.throttle = () => {
      throw new Error('policy unreadable');
    };
    const rows = await runDotExecutorSweep(
      [{ path: 'dots/ops.json', charter: charter() }],
      ports(),
      h.deps
    );
    expect(rows).toHaveLength(1);
  });
});

describe('dot-work-results prompt section', () => {
  it('is registered and shows the last five results', async () => {
    expect(DOT_PROMPT_SECTIONS.some((section) => section.id === 'dot-work-results')).toBe(true);
    const c = charter();
    const items = Array.from({ length: 6 }, (_, i) => item(`w${i}`, {}));
    for (const entry of items) await executeDotWorkItem(c, entry, ports(), harness(items).deps);
    const lines = dotWorkResultsPromptLines(c, { rootDir: TEST_ROOT, now: () => NOW });
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('dact-w1');
    expect(lines[5]).toContain('[done] dact-w5 (goal_turn');
    expect(readDotKrSnapshot(c, { rootDir: TEST_ROOT })).toBeUndefined();
  });
});

describe('executor bounds and escalation', () => {
  it('quarantines an item whose port never resolves at the wall-clock budget, and signals abort', async () => {
    const target = item('w1', {
      requested_work_shape: 'pipeline',
      pipeline_ref: 'pipelines/ok.json',
    });
    const h = harness([target]);
    let seen: AbortSignal | undefined;
    const p = ports({
      runPipeline: vi.fn((_ref: string, _ctx: Record<string, unknown>, signal?: AbortSignal) => {
        seen = signal;
        return new Promise<never>(() => {});
      }),
    });
    const c = charter({ goal: { statement: 'g', budget: { wall_clock_ms_per_wake: 40 } } });
    const row = await executeDotWorkItem(c, target, p, h.deps);
    expect(row).toMatchObject({ status: 'blocked', mode: 'pipeline' });
    expect(row.summary).toContain('exceeded wall_clock budget 40ms');
    expect(seen?.aborted).toBe(true);
    expect(row.summary).toContain('outcome uncertain');
    expect(h.releases[0].nextStatus).toBe('archived');
  });

  it('stops renewing the lease past the deadline', async () => {
    vi.useFakeTimers();
    const target = item('w1', {});
    const h = harness([target]);
    const renew = vi.fn();
    h.deps.renew = renew as unknown as Dep<'renew'>;
    h.deps.renewIntervalMs = 10;
    let clock = 0;
    h.deps.clock = () => clock;
    const p = ports({ runGoalTurn: vi.fn(() => new Promise<never>(() => {})) });
    const c = charter({ goal: { statement: 'g', budget: { wall_clock_ms_per_wake: 100 } } });
    const pending = executeDotWorkItem(c, target, p, h.deps);
    await vi.advanceTimersByTimeAsync(30);
    expect(renew).toHaveBeenCalled();
    const before = renew.mock.calls.length;
    clock = 1_000; // the clock passes the deadline before the deadline timer fires
    await vi.advanceTimersByTimeAsync(30);
    expect(renew.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe('blocked');
  });

  it('denies (and audits once) an item scoped to another tenant without claiming it', async () => {
    const c = charter({ scope: { tier: 'confidential', tenant_slug: 'acme' } });
    const foreign = item('w1', {}, { context: { tenant_slug: 'globex' } } as Partial<WorkItem>);
    const untenanted = item('w2', {});
    const own = item('w3', {}, { context: { tenant_slug: 'acme' } } as Partial<WorkItem>);
    const h = harness([foreign, untenanted, own]);
    const row = await executeDotWorkItem(c, foreign, ports(), h.deps);
    expect(row).toMatchObject({ status: 'skipped', summary: DOT_EXECUTOR_CROSS_TENANT_DENIAL });
    expect(h.claims).toEqual([]);
    expect(h.audits[0]).toMatchObject({
      result: 'denied',
      metadata: { reason: 'cross_tenant_work_item', item_tenant_bound: true },
    });
    expect(JSON.stringify(h.audits[0])).not.toContain('globex');
    // The sweep skips both foreign items without using the per-dot quota and audits once each.
    const rows = await runDotExecutorSweep(
      [{ path: 'dots/ops.json', charter: c }],
      ports(),
      h.deps
    );
    expect(rows.map((r) => r.work_item_id)).toEqual(['w3']);
    expect(h.claims.map((cl) => cl.itemId)).toEqual(['w3']);
    expect(h.audits.filter((a) => a.result === 'denied')).toHaveLength(2);
  });

  it('skips a dot whose own daily token cap is reached', async () => {
    const h = harness([item('w1', {})]);
    h.deps.tokenCapReached = (c) => c.dot_id === 'ops';
    const rows = await runDotExecutorSweep(
      [{ path: 'dots/ops.json', charter: charter() }],
      ports(),
      h.deps
    );
    expect(rows).toEqual([]);
    expect(h.claims).toEqual([]);
  });

  it('starts no new item once the sweep budget is spent', async () => {
    const h = harness([item('w1', {}), item('w2', { dot_id: 'second' })]);
    let clock = 0;
    h.deps.clock = () => clock;
    h.deps.sweepBudgetMs = 100;
    const p = ports({
      runGoalTurn: vi.fn(async () => {
        clock += 150;
        return { turnsRun: 1, finalState: 'complete', goal: {}, finalText: 'ok' };
      }),
    });
    const rows = await runDotExecutorSweep(
      [
        { path: 'dots/ops.json', charter: charter() },
        { path: 'dots/second.json', charter: charter({ dot_id: 'second' }) },
      ],
      p,
      h.deps
    );
    expect(rows.map((r) => r.work_item_id)).toEqual(['w1']);
  });

  it('reaps stranded dot claims before the sweep and escalates reaper-parked items', async () => {
    const parked = item('w9', {}, { status: 'blocked', version: 4 } as Partial<WorkItem>);
    const reap = vi.fn(() => ({ expired: [], recovered: [], parked: [parked], replayed: [] }));
    const update = vi.fn();
    const h = harness([]);
    h.deps.reap = reap;
    h.deps.update = update as unknown as Dep<'update'>;
    await runDotExecutorSweep([{ path: 'dots/ops.json', charter: charter() }], ports(), h.deps);
    expect(reap).toHaveBeenCalledWith(expect.objectContaining({ maxErrorAttempts: 3 }));
    const filter = (reap.mock.calls[0] as unknown as [ReapOptions])[0].itemFilter as (
      i: WorkItem
    ) => boolean;
    expect(filter(item('x', {}))).toBe(true);
    expect(filter({ ...item('y', {}), metadata: {} } as WorkItem)).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'w9', status: 'archived', expectedVersion: 4 })
    );
    expect(results(charter())[0]).toMatchObject({
      work_item_id: 'w9',
      status: 'failed',
      mode: 'escalated',
    });
    expect(h.inbox[0].payload).toMatchObject({ work_item_id: 'w9', escalated: true });
    expect(
      reapStrandedDotWorkItems([], {
        reap: () => {
          throw new Error('x');
        },
      })
    ).toBeUndefined();
  });

  it('shows escalations in the executor status section', async () => {
    expect(DOT_STATUS_SECTIONS.some((section) => section.id === 'executor')).toBe(true);
    const target = item('w1', { requested_work_shape: 'mission' });
    await executeDotWorkItem(charter(), target, ports(), harness([target]).deps);
    const status = dotExecutorStatusSection().collect(charter(), {
      rootDir: TEST_ROOT,
      now: () => NOW,
    });
    expect(status).toMatchObject({
      results_total: 1,
      escalations_total: 1,
      recent_escalations: [{ work_item_id: 'w1', status: 'blocked', mode: 'escalated' }],
    });
  });
});

describe('capability, pre-effect and report recovery (PR #915 review)', () => {
  it('closes an unavailable task_session as blocked without waking the dot', async () => {
    const target = item('w1', {});
    const h = harness([target]);
    const p = ports({ taskSessionUnavailable: DOT_EXECUTOR_TASK_SESSION_GUIDANCE });
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(row).toMatchObject({
      status: 'blocked',
      mode: 'escalated',
      reason_code: 'capability_unavailable',
      report_suppressed: 'capability_unavailable',
    });
    expect(p.runGoalTurn).not.toHaveBeenCalled();
    expect(h.releases[0].nextStatus).toBe('archived');
    expect(h.inbox).toHaveLength(0);
    expect(results(charter())[0].report_enqueued_at).toBeDefined();
  });

  it('blocks an item without requested_work_shape instead of defaulting to task_session', async () => {
    const target = item('w1', { requested_work_shape: undefined });
    const h = harness([target]);
    const p = ports();
    const row = await executeDotWorkItem(charter(), target, p, h.deps);
    expect(row).toMatchObject({ status: 'blocked', summary: DOT_EXECUTOR_MISSING_SHAPE_GUIDANCE });
    expect(p.runGoalTurn).not.toHaveBeenCalled();
  });

  it('steers mission guidance to allowed pipelines or direct_reply, never task_session', () => {
    expect(DOT_EXECUTOR_MISSION_GUIDANCE).not.toContain('task_session');
    expect(DOT_EXECUTOR_MISSION_GUIDANCE).toContain('direct_reply');
  });

  it('returns a pre-effect failure to ready (no quarantine, no wake) until the attempt bound', async () => {
    const target = item('w1', {
      requested_work_shape: 'pipeline',
      pipeline_ref: 'pipelines/ok.json',
    });
    const p = ports({
      runPipeline: vi.fn(async () => {
        throw new DotExecutorPreEffectError("pipeline 'pipelines/ok.json' could not be loaded");
      }),
    });
    const first = harness([target], 1);
    const row = await executeDotWorkItem(charter(), target, p, first.deps);
    expect(row).toMatchObject({
      status: 'failed',
      mode: 'pipeline',
      reason_code: 'pre_effect_failure',
    });
    expect(first.releases[0].nextStatus).toBe('ready');
    expect(first.releases[0].metadata?.dot_executor).toMatchObject({ retryable: true });
    expect(first.inbox).toHaveLength(0);
    // Not terminal and not uncertain: the item stays claimable.
    expect(listClaimableDotWorkItems(charter(), first.deps).map((i) => i.item_id)).toEqual(['w1']);

    const last = harness([target], DOT_EXECUTOR_MAX_ATTEMPTS);
    const final = await executeDotWorkItem(charter(), target, p, last.deps);
    expect(final).toMatchObject({ status: 'failed', mode: 'escalated' });
    expect(final.summary).toContain('failed before any effect');
    expect(last.releases[0].nextStatus).toBe('archived');
    expect(last.inbox[0].text).toContain('fix the cause, then re-propose');
    expect(last.inbox[0].text).not.toContain('verify effects');
  });

  it('treats legacy rows without report_to_dot_id as reported, and recovers new ones once', async () => {
    const c = charter();
    const file = path.join(TEST_ROOT, dotStatePath(c, DOT_WORK_RESULTS_FILE));
    safeMkdir(path.dirname(file), { recursive: true });
    const base = {
      dot_id: 'ops',
      action_ref: 'dact',
      mode: 'pipeline' as const,
      status: 'done' as const,
      summary: 's',
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
    };
    for (let i = 0; i < 5; i += 1) appendJsonLine(file, { ...base, work_item_id: `legacy-${i}` });
    appendJsonLine(file, { ...base, work_item_id: 'pending-1', report_to_dot_id: 'ops' });
    const h = harness([]);
    await runDotExecutorSweep([{ path: 'dots/ops.json', charter: c }], ports(), h.deps);
    expect(h.inbox.map((entry) => entry.payload?.work_item_id)).toEqual(['pending-1']);
    await runDotExecutorSweep([{ path: 'dots/ops.json', charter: c }], ports(), h.deps);
    expect(h.inbox).toHaveLength(1);
    expect(results(c).filter((row) => row.report_enqueued_at)).toHaveLength(1);
  });

  it('reads work results through the per-sweep cache', async () => {
    const target = item('w1', {});
    const h = harness([target]);
    const cached: DotWorkResultRow = {
      dot_id: 'ops',
      work_item_id: 'w1',
      action_ref: 'dact-w1',
      mode: 'goal_turn',
      status: 'done',
      summary: 'done elsewhere',
      started_at: NOW.toISOString(),
      completed_at: NOW.toISOString(),
      report_enqueued_at: NOW.toISOString(),
    };
    const resultsCache = new Map([
      [`${dotStatePath(charter(), DOT_WORK_RESULTS_FILE)}\u0000ops`, [cached]],
    ]);
    const rows = await runDotExecutorSweep(
      [{ path: 'dots/ops.json', charter: charter() }],
      ports(),
      { ...h.deps, resultsCache }
    );
    expect(rows).toEqual([]);
    expect(h.claims).toHaveLength(0);
  });
});
