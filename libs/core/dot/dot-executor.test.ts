import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import type {
  ClaimWorkItemInput,
  ReleaseWorkItemInput,
  WorkItem,
} from '../workforce/work-coordination-types.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import {
  DOT_EXECUTOR_CROSS_TENANT_DENIAL,
  DOT_EXECUTOR_MISSION_GUIDANCE,
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

interface Harness {
  deps: DotExecutorDeps;
  claims: ClaimWorkItemInput[];
  releases: ReleaseWorkItemInput[];
  inbox: DotInboxEntryInput[];
  audits: Array<Record<string, any>>;
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
        lease: { lease_id: 'lease-1' } as any,
      };
    },
    release: (input) => {
      h.releases.push(input);
      return { item: {} as WorkItem, lease: {} as any };
    },
    renew: vi.fn() as any,
    throttle: () => 'normal',
    tokenCapReached: () => false,
    reap: () => ({ expired: [], recovered: [], parked: [], replayed: [] }),
    appendInbox: (input) => void h.inbox.push(input),
    audit: (entry) => void h.audits.push(entry as Record<string, any>),
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
});

describe('executeDotWorkItem', () => {
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

  it('falls back to one read-only delegated turn without a live tool backend', async () => {
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

  it('re-queues a failure silently until the attempt limit, then blocks and reports', async () => {
    const target = item('w1', {});
    const failing = ports({
      runGoalTurn: vi.fn(async () => {
        throw new Error('provider down');
      }),
    });
    const first = harness([target], 1);
    const row = await executeDotWorkItem(charter(), target, failing, first.deps);
    expect(row).toMatchObject({ status: 'failed', summary: 'provider down' });
    expect(first.releases[0].nextStatus).toBe('ready');
    expect(first.inbox).toHaveLength(0);
    const last = harness([target], 3);
    await executeDotWorkItem(charter(), target, failing, last.deps);
    expect(last.releases[0].nextStatus).toBe('archived');
    expect(last.inbox).toHaveLength(1);
  });

  it('marks a goal that ran out of budget as failed and a blocked goal as blocked', async () => {
    const target = item('w1', {});
    const paused = ports({
      runGoalTurn: vi.fn(async () => ({ turnsRun: 4, finalState: 'paused', goal: {} })),
    });
    expect(
      (await executeDotWorkItem(charter(), target, paused, harness([target]).deps)).status
    ).toBe('failed');
    const blocked = ports({
      runGoalTurn: vi.fn(async () => ({
        turnsRun: 1,
        finalState: 'blocked',
        goal: {},
        finalText: 'needs creds',
      })),
    });
    const row = await executeDotWorkItem(charter(), target, blocked, harness([target]).deps);
    expect(row).toMatchObject({ status: 'blocked', summary: 'needs creds' });
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
  it('fails an item whose port never resolves once the wall-clock budget runs out, and aborts the port', async () => {
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
    expect(row).toMatchObject({ status: 'failed', mode: 'pipeline' });
    expect(row.summary).toContain('exceeded wall_clock budget 40ms');
    expect(seen?.aborted).toBe(true);
    // first attempt: re-queued, not escalated
    expect(h.releases[0].nextStatus).toBe('ready');
  });

  it('stops renewing the lease past the deadline', async () => {
    vi.useFakeTimers();
    const target = item('w1', {});
    const h = harness([target]);
    const renew = vi.fn();
    h.deps.renew = renew as any;
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
    expect((await pending).status).toBe('failed');
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
    h.deps.update = update as any;
    await runDotExecutorSweep([{ path: 'dots/ops.json', charter: charter() }], ports(), h.deps);
    expect(reap).toHaveBeenCalledWith(expect.objectContaining({ maxErrorAttempts: 3 }));
    const filter = (reap.mock.calls[0] as any)[0].itemFilter as (i: WorkItem) => boolean;
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
