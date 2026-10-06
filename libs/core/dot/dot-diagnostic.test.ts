import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  createWorkItem,
  claimWorkItem,
  getWorkItem,
  setWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import {
  executeDotWorkItem,
  runDotExecutorSweep,
  type DotExecutorDeps,
  type DotExecutorPorts,
} from './dot-executor.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { readJsonLines } from '../foundation/json.js';
import {
  applyDotWakeCircuit,
  DOT_INBOX_PATH,
  DOT_TOKEN_USAGE_PATH,
  evaluateDotProbeTriggers,
  evaluateDotTriggersDue,
  listActiveDotHeartbeatIds,
  readDotWakeLedger,
  recordDotTokenUsage,
  runDotWake,
  type DueDotTrigger,
} from './dot-runtime.js';
import { runDotWakeWithGoalDriver } from './dot-wake-orchestration.js';
import { evaluateDotCronCatchUp, evaluateDotFollowupsDue } from './dot-followups.js';
import { appendDotInboxEntry } from './dot-inbox.js';
import {
  appendWorkResult,
  readDotWorkResults,
  reconcileExecutorReports,
} from './dot-executor-reports.js';
import {
  DOT_FOLLOWUPS_FILE,
  DOT_WORK_RESULTS_FILE,
  dotStatePath,
  type DotWorkResultRow,
} from './dot-state-paths.js';
import { stubReasoningBackend } from '../reasoning/reasoning-backend.js';
import {
  FRONT_DESK_DIAGNOSTIC_PIPELINE,
  isFrontDeskDiagnosticDot,
  validateDotCharter,
  type DotCharter,
} from './dot-charter.js';

const diagnostic = (): DotCharter => ({
  kind: 'dot-charter',
  dot_id: 'front-desk-diagnostic',
  version: '1.0.0',
  title: 'First diagnostic job',
  purpose: 'Run the approved receipt diagnostic.',
  status: 'active',
  scope: { tier: 'public', tenant_slug: 'acme' },
  goal: { statement: 'Produce a verified receipt.' },
  attention: { triggers: [] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_work_shapes: ['pipeline'],
    allowed_pipelines: [FRONT_DESK_DIAGNOSTIC_PIPELINE],
    max_concurrent_delegations: 1,
  },
  decisions: { default_decision: 'approve', escalate_channel: 'surface' },
  notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'dot-front-desk-diagnostic', execution_mode: 'front_desk_diagnostic' },
});

describe('front-desk diagnostic charter boundary', () => {
  it('accepts the explicitly constrained diagnostic contract', () => {
    expect(isFrontDeskDiagnosticDot(validateDotCharter(diagnostic()))).toBe(true);
  });
  it.each<[string, (c: DotCharter) => void]>([
    [
      'inherited objective probes',
      (c) => {
        c.team = { goal_ref: { organization_id: 'org-a', objective_id: 'ready' } };
      },
    ],
    [
      'unknown mode',
      (c) => {
        c.runtime.execution_mode = 'unknown' as never;
      },
    ],
    [
      'null mode',
      (c) => {
        c.runtime.execution_mode = null as never;
      },
    ],
    [
      'confidential scope',
      (c) => {
        c.scope.tier = 'confidential';
      },
    ],
    [
      'missing tenant',
      (c) => {
        delete c.scope.tenant_slug;
      },
    ],
    [
      'reserved tenant',
      (c) => {
        c.scope.tenant_slug = 'public';
      },
    ],
    [
      'multiple tenants',
      (c) => {
        c.scope.tenant_slug = 'acme,globex';
      },
    ],
    [
      'different authority',
      (c) => {
        c.authority.authority_role = 'mission_controller';
      },
    ],
    [
      'implicit shapes',
      (c) => {
        delete c.authority.allowed_work_shapes;
      },
    ],
    [
      'model-driven shape',
      (c) => {
        c.authority.allowed_work_shapes = ['pipeline', 'direct_reply'];
      },
    ],
    [
      'implicit pipeline',
      (c) => {
        delete c.authority.allowed_pipelines;
      },
    ],
    [
      'extra pipeline',
      (c) => {
        c.authority.allowed_pipelines!.push('pipelines/other.json');
      },
    ],
    [
      'pipeline alias',
      (c) => {
        c.authority.allowed_pipelines = ['./' + FRONT_DESK_DIAGNOSTIC_PIPELINE];
      },
    ],
    [
      'implicit decisions',
      (c) => {
        delete c.decisions;
      },
    ],
    [
      'auto decisions',
      (c) => {
        c.decisions!.default_decision = 'auto';
      },
    ],
    [
      'notify decisions',
      (c) => {
        c.decisions!.default_decision = 'notify';
      },
    ],
    [
      'external escalation',
      (c) => {
        c.decisions!.escalate_channel = 'slack';
      },
    ],
    [
      'cron wake',
      (c) => {
        c.attention.triggers = [{ kind: 'cron', cron: '* * * * *' }];
      },
    ],
    [
      'inbox wake',
      (c) => {
        c.attention.triggers = [{ kind: 'wake', channels: ['inbox'] }];
      },
    ],
    [
      'signal probe',
      (c) => {
        c.goal.signal_probes = [
          { signal: 'ready', probe: { type: 'file', path: 'receipt.json', expect: 'exists' } },
        ];
      },
    ],
    [
      'key results',
      (c) => {
        c.goal.key_results = [
          {
            kr_id: 'ready',
            title: 'Ready',
            metric: { source: 'file', path: 'receipt.json', json_path: 'ready' },
            target: 1,
            direction: 'increase',
          },
        ];
      },
    ],
    [
      'cadence',
      (c) => {
        c.operations_cadence = { tick_every_minutes: 5 };
      },
    ],
    [
      'handoff',
      (c) => {
        c.team = { accepts_handoffs_from: ['other-dot'] };
      },
    ],
    [
      'digest',
      (c) => {
        c.notification.digest_cron = '0 * * * *';
      },
    ],
    [
      'implicit delivery',
      (c) => {
        delete c.notification.delivery_mode;
      },
    ],
    [
      'live delivery',
      (c) => {
        c.notification.delivery_mode = 'live';
      },
    ],
    [
      'external destination',
      (c) => {
        c.notification.deliver_to.surface = 'slack';
      },
    ],
    [
      'external channel',
      (c) => {
        c.notification.deliver_to.channel = '#ops';
      },
    ],
    [
      'thread delivery',
      (c) => {
        c.notification.deliver_to.thread_ts = '123';
      },
    ],
    [
      'custom template',
      (c) => {
        c.notification.deliver_to.template = '{{text}}';
      },
    ],
  ])('fails closed for %s', (_name, mutate) => {
    const c = diagnostic();
    mutate(c);
    expect(() => validateDotCharter(c)).toThrow();
    expect(() => isFrontDeskDiagnosticDot(c)).toThrow();
  });
  it('leaves unmarked generic charters unchanged', () => {
    const c = diagnostic();
    delete c.runtime.execution_mode;
    delete c.scope.tenant_slug;
    c.authority.allowed_work_shapes = ['direct_reply'];
    c.attention.triggers = [{ kind: 'wake', channels: ['slack'] }];
    c.notification = { deliver_to: { surface: 'slack', channel: '#ops' } };
    expect(validateDotCharter(c)).toEqual(c);
    expect(isFrontDeskDiagnosticDot(c)).toBe(false);
  });
});

const ROOT = 'active/shared/tmp/dot-diagnostic-tests';
const now = () => new Date('2026-10-05T17:00:00Z');
function write(relative: string, value: unknown): string {
  const file = path.join(ROOT, relative);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(value) + '\n');
  return file;
}
function loaded(c = diagnostic()) {
  return { path: write('dots/diagnostic.json', c), charter: c };
}
afterEach(() => {
  safeRmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const recoveredWake: DueDotTrigger = {
  trigger: { kind: 'wake', channels: ['inbox'] },
  key: 'wake:recovered-executor-report',
};

describe('provider-free diagnostic lifecycle', () => {
  it('never resolves a provider or drives a manual, completion, or recovered wake', async () => {
    const entry = loaded();
    const generateWithTools = vi.fn(),
      delegateTask = vi.fn(),
      runLoop = vi.fn();
    const resolveWakeExecution = vi.fn(),
      dispatch = vi.fn();
    for (const trigger of [
      undefined,
      recoveredWake,
      { trigger: { kind: 'followup' as const }, key: 'followup:old' },
    ]) {
      expect(
        await runDotWake(entry, {
          rootDir: ROOT,
          now,
          trigger,
          runLoop,
          dispatch,
          resolveWakeExecution,
          backend: { generateWithTools, delegateTask },
        })
      ).toMatchObject({
        outcome: 'rejected',
        reason: expect.stringContaining('model-driven wakes'),
      });
    }
    for (const call of [resolveWakeExecution, generateWithTools, delegateTask, runLoop, dispatch])
      expect(call).not.toHaveBeenCalled();
    expect(readDotWakeLedger({ rootDir: ROOT })).toHaveLength(3);
    expect(
      readDotWakeLedger({ rootDir: ROOT }).every((r) => r.tokens_used === 0 && r.turns_run === 0)
    ).toBe(true);
    expect(safeExistsSync(path.join(ROOT, DOT_TOKEN_USAGE_PATH))).toBe(false);
  });
  it('guards the production orchestration before named backend lookup', async () => {
    const entry = loaded();
    const backendFor = vi.fn(() => {
      throw new Error('provider must not be resolved');
    });
    const goalDriver = vi.fn();
    const backend = {
      ...stubReasoningBackend,
      name: 'live-test-backend',
      generateWithTools: vi.fn(),
      delegateTask: vi.fn(),
    };
    entry.charter.runtime.reasoning_backend = 'live-test-backend';
    write('dots/diagnostic.json', entry.charter);
    expect(
      (
        await runDotWakeWithGoalDriver(entry, {
          rootDir: ROOT,
          now,
          backendFor,
          goalDriver,
          backend,
        })
      ).outcome
    ).toBe('rejected');
    for (const call of [backendFor, goalDriver, backend.generateWithTools, backend.delegateTask])
      expect(call).not.toHaveBeenCalled();
  });
  it('does not schedule addressed executor reports, restart followups, catchup or circuit recovery', async () => {
    const entry = loaded();
    appendDotInboxEntry(
      {
        dot_id: entry.charter.dot_id,
        channel: 'inbox',
        source: 'dot-executor',
        payload: { report_from: 'dot-executor' },
      },
      { rootDir: ROOT, now }
    );
    write(dotStatePath(entry.charter, DOT_FOLLOWUPS_FILE), {
      dot_id: entry.charter.dot_id,
      followup_id: 'old',
      reason: 'Queued before restart',
      created_at: '2026-10-04T10:00:00Z',
      due_at: '2026-10-04T11:00:00Z',
    });
    const beforeInbox = safeReadFile(path.join(ROOT, DOT_INBOX_PATH), { encoding: 'utf8' });
    const serviceCall = vi.fn();
    for (const c of [
      entry.charter,
      validateDotCharter(JSON.parse(safeReadFile(entry.path, { encoding: 'utf8' }) as string)),
    ]) {
      expect(evaluateDotTriggersDue(c, { rootDir: ROOT, now })).toEqual([]);
      expect(evaluateDotFollowupsDue(c, { rootDir: ROOT, now })).toEqual([]);
      expect(evaluateDotCronCatchUp(c, { rootDir: ROOT, now })).toEqual([]);
      expect(await evaluateDotProbeTriggers(c, { rootDir: ROOT, now, serviceCall })).toEqual([]);
      expect(applyDotWakeCircuit(c, [recoveredWake], { rootDir: ROOT, now })).toEqual([]);
    }
    expect(serviceCall).not.toHaveBeenCalled();
    expect(safeReadFile(path.join(ROOT, DOT_INBOX_PATH), { encoding: 'utf8' })).toBe(beforeInbox);
    expect(listActiveDotHeartbeatIds(ROOT)).toEqual([]);
  });
  it('fails closed when a saved diagnostic charter broadens after it was loaded', async () => {
    const entry = loaded(),
      changed = structuredClone(entry.charter);
    changed.authority.allowed_work_shapes = ['pipeline', 'direct_reply'];
    write('dots/diagnostic.json', changed);
    const resolveWakeExecution = vi.fn();
    expect(await runDotWake(entry, { rootDir: ROOT, now, resolveWakeExecution })).toMatchObject({
      outcome: 'failed',
    });
    expect(resolveWakeExecution).not.toHaveBeenCalled();
  });
  it('a queued diagnostic wake cannot become generic through a charter revision', async () => {
    const entry = loaded(),
      changed = structuredClone(entry.charter);
    delete changed.runtime.execution_mode;
    changed.attention.triggers = [{ kind: 'wake', channels: ['inbox'] }];
    write('dots/diagnostic.json', changed);
    const resolveWakeExecution = vi.fn();
    expect(await runDotWake(entry, { rootDir: ROOT, now, resolveWakeExecution })).toMatchObject({
      outcome: 'rejected',
    });
    expect(resolveWakeExecution).not.toHaveBeenCalled();
  });
  it('a generic wake revised to diagnostic is stopped before provider resolution', async () => {
    const c = diagnostic();
    delete c.runtime.execution_mode;
    c.attention.triggers = [{ kind: 'wake', channels: ['inbox'] }];
    const entry = loaded(c);
    write('dots/diagnostic.json', diagnostic());
    const backendFor = vi.fn(),
      goalDriver = vi.fn();
    expect(
      await runDotWakeWithGoalDriver(entry, { rootDir: ROOT, now, backendFor, goalDriver })
    ).toMatchObject({ outcome: 'rejected' });
    expect(backendFor).not.toHaveBeenCalled();
    expect(goalDriver).not.toHaveBeenCalled();
  });
  it('reconciles a durable completed result and artifact receipt without waking or losing accounting', () => {
    const entry = loaded();
    const row: DotWorkResultRow = {
      dot_id: entry.charter.dot_id,
      work_item_id: 'WI-DIAGNOSTIC',
      action_ref: 'receipt-1',
      mode: 'pipeline',
      status: 'done',
      summary: 'Verified receipt',
      started_at: now().toISOString(),
      completed_at: now().toISOString(),
      report_to_dot_id: entry.charter.dot_id,
      front_desk_verification: {
        artifact_path: 'active/shared/artifacts/public/acme/receipt.json',
        sha256: 'a'.repeat(64),
        request_digest: 'b'.repeat(64),
        revision: 1,
        verified_at: now().toISOString(),
      },
    };
    const deps = { rootDir: ROOT, now, listItems: () => [] };
    appendWorkResult(entry.charter, row, deps);
    recordDotTokenUsage(entry.charter.dot_id, 7, deps);
    const tokensBefore = safeReadFile(path.join(ROOT, DOT_TOKEN_USAGE_PATH), { encoding: 'utf8' });
    reconcileExecutorReports([entry], deps);
    expect(readDotWorkResults(entry.charter, deps)).toEqual([
      { ...row, report_enqueued_at: now().toISOString() },
    ]);
    expect(readJsonLines(path.join(ROOT, DOT_INBOX_PATH))).toHaveLength(1);
    const resultBefore = safeReadFile(
      path.join(ROOT, dotStatePath(entry.charter, DOT_WORK_RESULTS_FILE)),
      { encoding: 'utf8' }
    );
    reconcileExecutorReports(
      [{ ...entry, charter: validateDotCharter(structuredClone(entry.charter)) }],
      deps
    );
    expect(readJsonLines(path.join(ROOT, DOT_INBOX_PATH))).toHaveLength(1);
    expect(evaluateDotTriggersDue(entry.charter, deps)).toEqual([]);
    expect(
      safeReadFile(path.join(ROOT, dotStatePath(entry.charter, DOT_WORK_RESULTS_FILE)), {
        encoding: 'utf8',
      })
    ).toBe(resultBefore);
    expect(safeReadFile(path.join(ROOT, DOT_TOKEN_USAGE_PATH), { encoding: 'utf8' })).toBe(
      tokensBefore
    );
  });
  it('unmarked generic dots still wake for completion reports and remain supervised', async () => {
    const c = diagnostic();
    delete c.runtime.execution_mode;
    c.attention.triggers = [{ kind: 'wake', channels: ['inbox'] }];
    const entry = loaded(c);
    appendDotInboxEntry(
      { dot_id: c.dot_id, channel: 'inbox', payload: { report_from: 'dot-executor' } },
      { rootDir: ROOT, now }
    );
    const due = evaluateDotTriggersDue(c, { rootDir: ROOT, now });
    expect(due).toHaveLength(1);
    const runLoop = vi.fn(async () => ({ turnsRun: 1, goal: { budgetStats: { tokensUsed: 2 } } }));
    expect(
      await runDotWake(entry, { rootDir: ROOT, now, hasRole: () => true, trigger: due[0], runLoop })
    ).toMatchObject({ outcome: 'delivered' });
    expect(runLoop).toHaveBeenCalledOnce();
    expect(listActiveDotHeartbeatIds(ROOT)).toEqual([c.runtime.heartbeat_id]);
  });
});

describe('diagnostic executor boundary', () => {
  it.each([
    'direct_reply',
    'task_session',
    'unbound pipeline',
    'other pipeline',
    'forged binding',
    'changed charter',
    'malformed mode',
    'generic revised to diagnostic',
  ])(
    'closes %s as blocked with durable accounting and no model or pipeline call',
    async (scenario) => {
      const entry = loaded();
      const item: WorkItem = {
        item_id: 'WI-DIAGNOSTIC-REFUSED',
        title: 'Old queued work',
        description: 'Unrelated work',
        status: 'ready',
        priority: 'normal',
        source: 'local',
        source_ref: 'diagnostic-fixture',
        project_id: 'default',
        labels: [],
        dependencies: [],
        version: 1,
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
        context: { tenant_slug: 'acme', project_id: 'default', work_shape: 'routine_operation' },
        metadata: {
          dot_id: entry.charter.dot_id,
          action_ref: 'diagnostic-refused',
          requested_work_shape:
            scenario === 'direct_reply' || scenario === 'task_session' ? scenario : 'pipeline',
          pipeline_ref:
            scenario === 'other pipeline' ? 'pipelines/other.json' : FRONT_DESK_DIAGNOSTIC_PIPELINE,
          ...(scenario === 'unbound pipeline'
            ? {}
            : { front_desk_execution: { work_item_id: 'WI-DIAGNOSTIC-REFUSED' } }),
        },
      };
      if (scenario === 'changed charter') {
        const current = structuredClone(entry.charter);
        delete current.runtime.execution_mode;
        current.attention.triggers = [{ kind: 'wake', channels: ['inbox'] }];
        write('dots/diagnostic.json', current);
      }
      if (scenario === 'malformed mode') entry.charter.runtime.execution_mode = 'unsafe' as never;
      if (scenario === 'generic revised to diagnostic') {
        delete entry.charter.runtime.execution_mode;
        item.metadata!.requested_work_shape = 'direct_reply';
      }
      const ports: DotExecutorPorts = {
        runGoalTurn: vi.fn(),
        delegateText: vi.fn(),
        runPipeline: vi.fn(),
        goalMode: vi.fn(() => 'tool' as const),
      };
      const claim = vi.fn(() => ({
        item: { ...item, status: 'in_progress', current_attempt_id: 'attempt-diagnostic' },
        lease: { lease_id: 'lease-diagnostic' },
      }));
      const release = vi.fn(() => ({})),
        recordTokens = vi.fn();
      const deps: DotExecutorDeps = {
        rootDir: ROOT,
        now,
        claim: claim as never,
        release: release as never,
        audit: vi.fn(),
        recordTokens,
      };
      expect(await executeDotWorkItem(entry.charter, item, ports, deps)).toMatchObject({
        mode: 'escalated',
        status: 'blocked',
        summary: expect.stringContaining('diagnostic execution refused before effects'),
      });
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'archived' }));
      expect(readDotWorkResults(entry.charter, deps)).toHaveLength(1);
      expect(readJsonLines(path.join(ROOT, DOT_INBOX_PATH))).toHaveLength(1);
      for (const call of [
        ports.goalMode,
        ports.runGoalTurn,
        ports.delegateText,
        ports.runPipeline,
        recordTokens,
      ])
        expect(call).not.toHaveBeenCalled();
      expect(await executeDotWorkItem(entry.charter, item, ports, deps)).toMatchObject({
        status: 'skipped',
      });
      expect(claim).toHaveBeenCalledOnce();
    }
  );
});

it('a bounded diagnostic pass leaves unrelated expired item and lease bytes untouched', async () => {
  const namespace = 'diagnostic-bounded-reaper-test';
  setWorkCoordinationNamespace(namespace);
  clearWorkCoordinationStore();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  try {
    const entry = loaded();
    const own = createWorkItem({
      title: 'Stranded diagnostic',
      description: 'fixture',
      context: { tenant_slug: 'acme' },
      metadata: { dot_id: entry.charter.dot_id },
    });
    const unrelated = createWorkItem({
      title: 'Other tenant',
      description: 'fixture',
      context: { tenant_slug: 'globex' },
      metadata: { dot_id: 'other-dot' },
    });
    claimWorkItem({
      itemId: own.item_id,
      actorPeerId: 'dot:' + entry.charter.dot_id,
      purpose: 'test',
      ttlMs: 1000,
    });
    claimWorkItem({
      itemId: unrelated.item_id,
      actorPeerId: 'dot:other-dot',
      purpose: 'test',
      ttlMs: 1000,
    });
    vi.setSystemTime(new Date('2026-10-05T12:00:02Z'));
    const leasesPath = 'active/shared/runtime/work-coordination/' + namespace + '/leases.jsonl';
    const leasesBefore = safeReadFile(leasesPath, { encoding: 'utf8' });
    const ownBefore = getWorkItem(own.item_id),
      otherBefore = getWorkItem(unrelated.item_id);
    const ports: DotExecutorPorts = {
      runGoalTurn: vi.fn(),
      delegateText: vi.fn(),
      runPipeline: vi.fn(),
    };
    const rows = await runDotExecutorSweep([entry], ports, {
      rootDir: ROOT,
      scopeToActiveCharters: true,
      assertTenant: () => undefined,
      throttle: () => 'normal',
      tokenCapReached: () => false,
      audit: vi.fn(),
    });
    expect(rows).toContainEqual(
      expect.objectContaining({
        work_item_id: own.item_id,
        status: 'skipped',
        summary: expect.stringContaining('normal governed recovery'),
      })
    );
    expect(getWorkItem(own.item_id)).toEqual(ownBefore);
    expect(getWorkItem(unrelated.item_id)).toEqual(otherBefore);
    expect(safeReadFile(leasesPath, { encoding: 'utf8' })).toBe(leasesBefore);
    expect(ports.runPipeline).not.toHaveBeenCalled();
    expect(ports.runGoalTurn).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  }
});

it('an unbound supervisor preserves a diagnostic ready item without claims or provider resolution', async () => {
  setWorkCoordinationNamespace('diagnostic-unbound-supervisor-test');
  clearWorkCoordinationStore();
  try {
    const entry = loaded();
    const item = createWorkItem({
      title: 'Approved pending diagnostic',
      description: 'fixture',
      context: { tenant_slug: 'acme' },
      metadata: { dot_id: entry.charter.dot_id, requested_work_shape: 'pipeline' },
    });
    const before = getWorkItem(item.item_id),
      factory = vi.fn();
    const reap = vi.fn(() => ({ expired: [], recovered: [], parked: [], replayed: [] }));
    const claim = vi.fn(),
      release = vi.fn(),
      update = vi.fn(),
      appendInbox = vi.fn();
    expect(
      await runDotExecutorSweep([entry], factory, {
        rootDir: ROOT,
        reap,
        claim,
        release,
        update,
        appendInbox,
      })
    ).toEqual([]);
    expect(getWorkItem(item.item_id)).toEqual(before);
    expect(readDotWorkResults(entry.charter, { rootDir: ROOT })).toEqual([]);
    expect(reap).toHaveBeenCalledOnce();
    for (const call of [factory, claim, release, update, appendInbox])
      expect(call).not.toHaveBeenCalled();
  } finally {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  }
});
