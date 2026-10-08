import { describe, it, expect, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import {
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { MetricsCollector } from '../metrics.js';
import { logger } from '../core.js';
import {
  ensureRecoveryScaffold,
  loadMissionFlightRecorderAtPath,
  recordArtifactReview,
  recordEvidence,
  recordTask,
  shouldSkipResumeEntry,
  RESUME_IDEMPOTENCY_WINDOW_MS,
} from './mission-maintenance.js';
import { inferProviderFromActorId, recordDirectCliTaskUsage } from './mission-direct-cli-usage.js';

const mocks = vi.hoisted(() => ({ spawnManagedProcess: vi.fn() }));
// Route the shared usage ledger to a per-test collector so record-evidence
// never appends to the operator's work/metrics/resource-usage.jsonl.
const usageCollector = vi.hoisted(() => ({
  current: null as null | Pick<MetricsCollector, 'recordResourceUsage'>,
}));

vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));
vi.mock('../metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../metrics.js')>();
  const fallback = new actual.MetricsCollector({ persist: false });
  return {
    ...actual,
    metrics: new Proxy(fallback, {
      get: (target, prop) => {
        const current = usageCollector.current;
        const active = current && prop in current ? current : target;
        const value = Reflect.get(active, prop);
        return typeof value === 'function' ? value.bind(active) : value;
      },
    }),
  };
});

describe('shouldSkipResumeEntry (Phase B-3 idempotency)', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');

  it('returns false for empty history', () => {
    expect(shouldSkipResumeEntry([], now)).toBe(false);
  });

  it('returns false when last event is not RESUME', () => {
    expect(
      shouldSkipResumeEntry([{ ts: '2026-05-07T11:59:50.000Z', event: 'CHECKPOINT' }], now)
    ).toBe(false);
  });

  it('returns true when last RESUME is within window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' }], // 30s ago
        now
      )
    ).toBe(true);
  });

  it('returns false when last RESUME is past the window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:58:00.000Z', event: 'RESUME' }], // 2 min ago
        now
      )
    ).toBe(false);
  });

  it('returns false at exact window boundary (strictly less than)', () => {
    const exactlyOnBoundary = new Date(now.getTime() - RESUME_IDEMPOTENCY_WINDOW_MS).toISOString();
    expect(shouldSkipResumeEntry([{ ts: exactlyOnBoundary, event: 'RESUME' }], now)).toBe(false);
  });

  it('returns false on malformed timestamp', () => {
    expect(shouldSkipResumeEntry([{ ts: 'not-a-date', event: 'RESUME' }], now)).toBe(false);
  });

  it('only inspects the LAST entry, not earlier RESUMEs', () => {
    expect(
      shouldSkipResumeEntry(
        [
          { ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' },
          { ts: '2026-05-07T11:59:31.000Z', event: 'CHECKPOINT' },
        ],
        now
      )
    ).toBe(false);
  });

  it('coalesces a chain of rapid RESUMEs into one', () => {
    // Simulate: orchestrator restarted 3 times in quick succession.
    // The actual call site only adds an entry when this returns false,
    // so the second and third calls would both see "last is RESUME within window".
    const history: Array<{ ts: string; event: string }> = [];
    const ts1 = new Date(now.getTime() - 50_000).toISOString();
    history.push({ ts: ts1, event: 'RESUME' }); // first one was added

    expect(shouldSkipResumeEntry(history, now)).toBe(true); // 50s ago, within window

    const muchLater = new Date(now.getTime() + 70_000); // 70s later, past window
    expect(shouldSkipResumeEntry(history, muchLater)).toBe(false);
  });

  it('honors a custom window override', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:55.000Z', event: 'RESUME' }], // 5s ago
        now,
        2_000 // 2s window
      )
    ).toBe(false);
  });

  it('records task details into the mission state context', async (ctx) => {
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    const missionId = 'MSN-MAINTENANCE-RECORD-TASK';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    // The fixture mission lives in the live mission tree; leave nothing behind.
    ctx.onTestFinished(() => {
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    });
    safeMkdir(missionPath, { recursive: true });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: missionId,
          tier: 'public',
          status: 'active',
          execution_mode: 'delegated',
          priority: 1,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'main',
            start_commit: 'start',
            latest_commit: 'latest',
            checkpoints: [],
          },
          history: [],
        },
        null,
        2
      )
    );

    await recordTask(missionId, 'Dispatched work item WIT-1', {
      next_step: 'await response',
      context_pack_id: 'CPK-TEST-1',
      context_pack_path: `${missionPath}/coordination/context-packs/CPK-TEST-1.json`,
      context_pack_summary: 'Scoped context pack summary',
      context_pack_pruning_summary: {
        budget_chars: 900,
        estimated_chars: 4800,
        kept_sections: ['scope', 'mission'],
        pruned_sections: ['knowledge_hints'],
        rollup_summary: 'pruned knowledge hints',
      },
      context_chars: 4800,
      pruned_chars: 3900,
      rollup_used: true,
      result_schema_ok: true,
      needs_count: 0,
      cognitive_route_summary: 'fast_llm, owner=agent',
      drift_watchdog_summary: 'attempts=1; repeat=0; stop=no; attention=no',
      work_item_dispatch_summary: {
        item_id: 'WIT-1',
        team_role: 'implementer',
        assignee_peer_id: 'agent-1',
        execution_mode: 'agent',
      },
    });

    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.context.last_action).toBe('Dispatched work item WIT-1');
    expect(state.context.next_step).toBe('await response');
    expect(state.context.context_pack_id).toBe('CPK-TEST-1');
    expect(state.context.context_pack_summary).toBe('Scoped context pack summary');
    expect(state.context.context_pack_pruning_summary.pruned_sections).toEqual(['knowledge_hints']);
    expect(state.context.context_chars).toBe(4800);
    expect(state.context.pruned_chars).toBe(3900);
    expect(state.context.rollup_used).toBe(true);
    expect(state.context.result_schema_ok).toBe(true);
    expect(state.context.needs_count).toBe(0);
    expect(state.context.work_item_dispatch_summary.drift_watchdog_summary).toBe(
      'attempts=1; repeat=0; stop=no; attention=no'
    );
    expect(state.history.at(-1)?.event).toBe('RECORD_TASK');
  });

  it('loads a flight recorder through the canonical schema and regular-file boundary', () => {
    const recorderPath = pathResolver.rootResolve(
      `active/shared/tmp/mission-flight-recorder-${process.pid}.json`
    );
    const record = {
      ts: '2026-06-22T00:00:00.000Z',
      description: 'Continue the verified mission task',
      details: { next_step: 'run the focused check' },
    };
    safeWriteFile(recorderPath, JSON.stringify(record));
    try {
      expect(loadMissionFlightRecorderAtPath(recorderPath)).toEqual(record);
      safeWriteFile(recorderPath, JSON.stringify({ ...record, unexpected: true }));
      expect(() => loadMissionFlightRecorderAtPath(recorderPath)).toThrow(
        'Invalid catalog mission-flight-recorder'
      );
    } finally {
      safeRmSync(recorderPath, { force: true });
    }
  });

  it('rejects a directory at the flight recorder path', () => {
    const recorderPath = pathResolver.rootResolve(
      `active/shared/tmp/mission-flight-recorder-directory-${process.pid}`
    );
    safeMkdir(recorderPath, { recursive: true });
    try {
      expect(() => loadMissionFlightRecorderAtPath(recorderPath)).toThrow(
        'record must be a regular file'
      );
    } finally {
      safeRmSync(recorderPath, { recursive: true, force: true });
    }
  });

  it('creates a reconcile-work scaffold for interrupted artifact recovery', () => {
    const previousRole = process.env.MISSION_ROLE;
    const previousPersona = process.env.KYBERION_PERSONA;
    const missionId = 'MSN-MAINTENANCE-SCAFFOLD';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const scaffoldPath = pathResolver.rootResolve(
      `active/shared/tmp/reconciliation-${missionId}.scaffold.json`
    );
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'mission_controller';
    safeRmSync(missionPath, { recursive: true, force: true });
    safeRmSync(scaffoldPath, { force: true });
    safeMkdir(missionPath, { recursive: true });
    try {
      const first = ensureRecoveryScaffold(missionId);
      const second = ensureRecoveryScaffold(missionId);
      expect(first).toBe(second);
      expect(first).toContain(`reconciliation-${missionId}.scaffold.json`);
      expect(safeExistsSync(scaffoldPath)).toBe(true);
    } finally {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeRmSync(scaffoldPath, { force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
      if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = previousPersona;
    }
  });
});

describe('mission resume worker recovery ceremony', () => {
  it('publishes a dedicated recovery event after recording an explicit resume', async () => {
    const missionId = `MSN-MAINTENANCE-RECOVERY-${process.pid}-${Date.now()}`;
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const state = {
      mission_id: missionId,
      tier: 'public',
      status: 'active',
      execution_mode: 'delegated',
      priority: 1,
      assigned_persona: 'mission_controller',
      confidence_score: 1,
      git: { branch: 'main', start_commit: 'start', latest_commit: 'latest', checkpoints: [] },
      history: [],
    };
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
    safeRmSync(missionPath, { recursive: true, force: true });
    mocks.spawnManagedProcess.mockReset();
    let eventPathForCleanup: string | undefined;
    let payloadPathForCleanup: string | undefined;
    safeMkdir(missionPath, { recursive: true });
    safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(state, null, 2));

    try {
      const { resumeMission } = await import('./mission-maintenance.js');
      const { loadMissionOrchestrationEvent } = await import('./mission-orchestration-events.js');
      await resumeMission(missionId, {
        readFocusedMissionId: () => null,
        writeFocusedMissionId: () => undefined,
        getCurrentBranch: () => 'main',
        syncProjectLedgerIfLinked: async () => undefined,
      });

      const recoveryStart = mocks.spawnManagedProcess.mock.calls.find(
        ([spec]) => spec?.metadata?.eventType === 'mission_worker_recovery_requested'
      );
      expect(recoveryStart).toBeDefined();
      const eventPath = recoveryStart?.[0]?.args?.[2];
      expect(typeof eventPath).toBe('string');
      eventPathForCleanup = String(eventPath);
      const event = loadMissionOrchestrationEvent(String(eventPath));
      payloadPathForCleanup = event.payload_ref
        ? pathResolver.rootResolve(event.payload_ref)
        : undefined;
      expect(event.event_type).toBe('mission_worker_recovery_requested');
      expect(event.payload).toEqual({ operation: 'resume_goal_driven' });
      expect(
        JSON.parse(
          safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
        ).history.at(-1)?.event
      ).toBe('RESUME');
    } finally {
      if (eventPathForCleanup) safeRmSync(eventPathForCleanup, { force: true });
      if (payloadPathForCleanup) safeRmSync(payloadPathForCleanup, { force: true });
      safeRmSync(missionPath, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });
});

describe('direct-CLI usage accounting', () => {
  type FixtureTask = Record<string, unknown>;

  /** Seed a git-backed fixture mission in the live mission tree; cleaned up after the test. */
  function seedMission(
    ctx: { onTestFinished: (fn: () => void) => void },
    tasks: FixtureTask[],
    files: string[]
  ) {
    const missionId = `MSN-MAINTENANCE-USAGE-${process.pid}-${Date.now()}`;
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const metricsDir = pathResolver.sharedTmp(`direct-cli-usage-test-${process.pid}-${Date.now()}`);
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
    ctx.onTestFinished(() => {
      usageCollector.current = null;
      safeRmSync(missionPath, { recursive: true, force: true });
      safeRmSync(metricsDir, { recursive: true, force: true });
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    });
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeExec('git', ['init', '-q'], { cwd: missionPath });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify({
        mission_id: missionId,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: { branch: 'main', start_commit: 'start', latest_commit: 'latest', checkpoints: [] },
        history: [],
      })
    );
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(tasks));
    for (const file of files) safeWriteFile(`${missionPath}/${file}`, `# ${file}\n`);
    const collector = new MetricsCollector({ metricsDir });
    usageCollector.current = collector;
    const readTasks = (): FixtureTask[] =>
      JSON.parse(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string);
    return { missionId, missionPath, collector, readTasks };
  }

  const evidenceArgs = (missionId: string) => ({
    missionId,
    note: 'done',
    actorId: 'codex-implementer',
    getGitHash: () => 'hash',
    syncProjectLedgerIfLinked: async () => undefined,
  });

  it('record-evidence appends one estimated direct_cli entry per completed task, never twice', async (ctx) => {
    const { missionId, collector } = seedMission(
      ctx,
      [
        { task_id: 'impl', status: 'planned', deliverable: 'evidence/report.md' },
        { task_id: 'later', status: 'planned', deliverable: 'evidence/missing.md' },
      ],
      ['evidence/report.md']
    );
    await recordEvidence({ ...evidenceArgs(missionId), taskId: 'impl' });
    // Re-recording an already-completed task adds no second entry.
    await recordEvidence({ ...evidenceArgs(missionId), taskId: 'impl' });
    // Deliverable missing → the task is not completed → no usage entry.
    await recordEvidence({ ...evidenceArgs(missionId), taskId: 'later', provider: 'claude' });

    const entries = collector.loadResourceUsageHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'resource_usage',
      resource_kind: 'llm',
      actor_id: 'codex-implementer',
      mission_id: missionId,
      quantity: 0,
      cost_usd: 0,
      status: 'estimated',
      source: 'direct_cli',
      scope: { scope_kind: 'task', tier: 'public', mission_id: missionId, task_id: 'impl' },
      metadata: {
        task_id: 'impl',
        event: 'record_evidence',
        estimated: true,
        provider: 'codex',
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
      },
    });
  });

  it('records an entry for each task completed by cascade', async (ctx) => {
    const { missionId, collector } = seedMission(
      ctx,
      [
        { task_id: 'design', status: 'planned', deliverable: 'evidence/design.md' },
        {
          task_id: 'build',
          status: 'planned',
          deliverable: 'evidence/build.md',
          dependencies: ['design'],
        },
      ],
      ['evidence/design.md', 'evidence/build.md']
    );
    await recordEvidence({ ...evidenceArgs(missionId), taskId: 'design' });
    const entries = collector.loadResourceUsageHistory();
    expect(entries.map((entry) => entry.metadata?.task_id)).toEqual(['design', 'build']);
    expect(entries[1].metadata).toMatchObject({ cascaded_from: 'design' });
  });

  it('a throwing usage collector does not block evidence recording', async (ctx) => {
    const { missionId, readTasks } = seedMission(
      ctx,
      [{ task_id: 'impl', status: 'planned', deliverable: 'evidence/report.md' }],
      ['evidence/report.md']
    );
    usageCollector.current = {
      recordResourceUsage: () => {
        throw new Error('ledger unavailable');
      },
    };
    await expect(
      recordEvidence({ ...evidenceArgs(missionId), taskId: 'impl' })
    ).resolves.toBeUndefined();
    expect(readTasks()[0].status).toBe('completed');
  });

  it('review-task records a review_task entry with the reviewer as actor', async (ctx) => {
    const { missionId, collector } = seedMission(
      ctx,
      [
        { task_id: 'impl', status: 'planned', deliverable: 'evidence/report.md' },
        {
          task_id: 'impl-review',
          status: 'planned',
          review_target: 'impl',
          deliverable: 'evidence/review.md',
          dependencies: ['impl'],
        },
      ],
      ['evidence/report.md', 'evidence/review.md']
    );
    await recordEvidence({ ...evidenceArgs(missionId), taskId: 'impl' });
    const result = await recordArtifactReview({
      missionId,
      reviewTaskId: 'impl-review',
      reviewerAgentId: 'claude-reviewer',
      findings: [],
      specialistRoles: ['code-reviewer'],
      getGitHash: () => 'hash',
    });
    expect(result.taskCompleted).toBe(true);
    const review = collector
      .loadResourceUsageHistory()
      .filter((entry) => entry.metadata?.event === 'review_task');
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      actor_id: 'claude-reviewer',
      status: 'estimated',
      source: 'direct_cli',
      scope: { task_id: 'impl-review' },
      metadata: { task_id: 'impl-review', provider: 'claude' },
    });
  });
});

describe('recordDirectCliTaskUsage', () => {
  const base = {
    missionId: 'MSN-USAGE-UNIT',
    taskId: 'T-1',
    event: 'record_evidence' as const,
  };

  it('keeps a confidential mission scoped to its tier and tenant', () => {
    const [entry] = recordDirectCliTaskUsage({
      ...base,
      actorId: 'agent-x',
      state: { tier: 'confidential', tenant_slug: 'acme-co' },
      collector: new MetricsCollector({ persist: false }),
    });
    expect(entry.scope).toMatchObject({
      scope_kind: 'task',
      tier: 'confidential',
      tenant_slug: 'acme-co',
      mission_id: 'MSN-USAGE-UNIT',
      task_id: 'T-1',
    });
  });

  it('records nothing (and warns) for a confidential mission without a tenant — never downgraded', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const recordResourceUsage = vi.fn(new MetricsCollector({ persist: false }).recordResourceUsage);
    try {
      const entries = recordDirectCliTaskUsage({
        ...base,
        state: { tier: 'confidential' },
        collector: { recordResourceUsage },
      });
      expect(entries).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage entry not recorded'));
    } finally {
      warn.mockRestore();
    }
  });

  it('drops an unknown --provider with a warning instead of tagging the entry llm', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const [entry] = recordDirectCliTaskUsage({
        ...base,
        actorId: 'implementation-architect',
        provider: 'not-a-provider',
        state: { tier: 'public' },
        collector: new MetricsCollector({ persist: false }),
      });
      expect(entry.resource_kind).toBe('other');
      expect(entry.metadata).not.toHaveProperty('provider');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'not-a-provider' ignored"));
      const [known] = recordDirectCliTaskUsage({
        ...base,
        provider: 'Gemini',
        state: { tier: 'public' },
        collector: new MetricsCollector({ persist: false }),
      });
      expect(known).toMatchObject({ resource_kind: 'llm', metadata: { provider: 'gemini' } });
    } finally {
      warn.mockRestore();
    }
  });

  it('infers the provider only from a known provider-id prefix', () => {
    expect(inferProviderFromActorId('claude-opus-reviewer')).toBe('claude');
    expect(inferProviderFromActorId('implementation-architect')).toBeUndefined();
    expect(inferProviderFromActorId(undefined)).toBeUndefined();
  });
});
