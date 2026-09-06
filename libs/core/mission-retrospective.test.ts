import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realFsSecureIo = vi.hoisted(() => ({
  assertSafeRepositoryPath: (filePath: string, options: { allowMissingLeaf?: boolean } = {}) => {
    const root = path.resolve(process.env.KYBERION_ROOT || process.cwd());
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`[RESOURCE_PATH_SCOPE] ${filePath}`);
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`[RESOURCE_PATH_SYMLINK] ${filePath}`);
        }
      } catch (error: any) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    if (!options.allowMissingLeaf && !fs.existsSync(resolved)) {
      throw new Error(`Resource path does not exist: ${resolved}`);
    }
    return resolved;
  },
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeLstat: (filePath: string) => fs.lstatSync(filePath),
  safeMkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    fs.mkdirSync(dirPath, { recursive: options?.recursive !== false }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  loadJson: <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
  loadJsonIfPresent: <T>(filePath: string): T | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  },
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));
vi.mock('./secure-io.js', () => realFsSecureIo);
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: realFsSecureIo.loadJson,
    loadJsonIfPresent: realFsSecureIo.loadJsonIfPresent,
    appendFile: realFsSecureIo.safeAppendFileSync,
    exists: realFsSecureIo.safeExistsSync,
    readFile: (filePath: string) => String(realFsSecureIo.safeReadFile(filePath)),
    stat: (filePath: string) => fs.statSync(filePath),
    writeFile: realFsSecureIo.safeWriteFile,
  }),
  registerFoundationIo: vi.fn(),
}));
vi.mock('./core.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const backendPrompt = vi.hoisted(() => vi.fn());
const backendName = vi.hoisted(() => ({ value: 'claude-agent' }));
vi.mock('./reasoning-backend.js', () => ({
  getReasoningBackend: () => ({ name: backendName.value, prompt: backendPrompt }),
}));

const notify = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('./operator-notifications.js', () => ({ notifyOperator: notify }));

const MISSION = 'MSN-RETRO-FIXTURE';

describe('mission retrospective loop', () => {
  let tmpRoot: string;
  let mod: typeof import('./mission-retrospective.js');
  let missionDir: string;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyberion-retro-${randomUUID()}`);
    missionDir = path.join(tmpRoot, 'active', 'missions', MISSION);
    fs.mkdirSync(path.join(missionDir, 'coordination', 'events'), { recursive: true });
    fs.mkdirSync(path.join(missionDir, 'coordination', 'tickets'), { recursive: true });
    fs.mkdirSync(path.join(missionDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpRoot, 'knowledge'), { recursive: true });
    const schemaPath = path.join(tmpRoot, 'knowledge/product/schemas/mission-state.schema.json');
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.copyFileSync(
      path.resolve(process.cwd(), 'knowledge/product/schemas/mission-state.schema.json'),
      schemaPath
    );
    // agent-performance-index.ts records outcomes through governed catalogs;
    // mission-retrospective.ts reads the dispatch manifest through one too.
    for (const schemaName of [
      'agent-role-outcome',
      'agent-performance-index',
      'mission-workitem-dispatch-manifest',
      'mission-ticket-dispatch-manifest',
      'mission-next-tasks',
      'model-role-outcome',
      'model-performance-index',
      'process-improvement-proposal',
    ]) {
      fs.copyFileSync(
        path.resolve(process.cwd(), `knowledge/product/schemas/${schemaName}.schema.json`),
        path.join(tmpRoot, `knowledge/product/schemas/${schemaName}.schema.json`)
      );
    }
    process.env.KYBERION_ROOT = tmpRoot;

    fs.writeFileSync(
      path.join(missionDir, 'NEXT_TASKS.json'),
      JSON.stringify([
        { task_id: 'T-1', assigned_to: { role: 'implementer' } },
        { task_id: 'T-2', assigned_to: { role: 'reviewer' } },
        { task_id: 'T-3', assigned_to: { role: 'qa' } },
      ])
    );
    fs.writeFileSync(
      path.join(missionDir, 'coordination', 'tickets', 'dispatch-manifest.json'),
      JSON.stringify({
        mission_id: MISSION,
        records: [
          { task_id: 'T-3', status: 'failed', notes: ['missing assigned_to.agent_id'] },
          {
            task_id: 'T-1',
            status: 'created',
            notes: ['role qa unstaffed; using reviewer staffing (x)'],
          },
        ],
      })
    );
    fs.writeFileSync(
      path.join(missionDir, 'coordination', 'events', 'task-events.jsonl'),
      [
        JSON.stringify({ decision: 'best_of_judged', payload: {} }),
        JSON.stringify({ decision: 'task_reviewed', payload: { rework_requested: true } }),
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(missionDir, 'mission-state.json'),
      JSON.stringify({
        mission_id: MISSION,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'worker',
        confidence_score: 1,
        git: {
          branch: 'mission-retrospective-test',
          start_commit: 'abc123',
          latest_commit: 'abc123',
          checkpoints: [],
        },
        history: [],
        context: { goal_reconciliation_round: 1 },
      })
    );
    fs.mkdirSync(path.join(tmpRoot, 'work', 'metrics'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'work', 'metrics', 'execution-metrics.jsonl'),
      [
        JSON.stringify({
          mission_id: MISSION,
          model: 'claude-fable-5',
          usage: { prompt_tokens: 100, completion_tokens: 40 },
          cost_usd: 0.0123,
        }),
        JSON.stringify({
          mission_id: 'OTHER-MISSION',
          model: 'codex',
          usage: { prompt_tokens: 900, completion_tokens: 900 },
          cost_usd: 9,
        }),
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'work', 'metrics', 'resource-usage.jsonl'),
      [
        JSON.stringify({
          type: 'resource_usage',
          mission_id: MISSION,
          resource_kind: 'llm',
          quantity: 1,
          unit: 'call',
          cost_usd: 0.02,
        }),
      ].join('\n') + '\n'
    );
    fs.mkdirSync(path.join(tmpRoot, 'active', 'shared', 'observability', 'mission-control'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        tmpRoot,
        'active',
        'shared',
        'observability',
        'mission-control',
        'agent-runtime-supervisor-events.jsonl'
      ),
      JSON.stringify({
        decision: 'agent_runtime_ask_completed',
        mission_id: MISSION,
        correlation_id: 'runtime-correlation-1',
        model_id: 'agy-runtime-model',
        input_tokens: 10,
        output_tokens: 5,
      }) + '\n'
    );

    vi.resetModules();
    mod = await import('./mission-retrospective.js');
    backendPrompt.mockReset();
    notify.mockClear();
    backendName.value = 'claude-agent';
  });

  afterEach(() => {
    delete process.env.KYBERION_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collects deterministic execution stats from mission records', () => {
    const stats = mod.collectMissionExecutionStats(MISSION);
    expect(stats.task_total).toBe(3);
    expect(stats.tasks_by_role).toEqual({ implementer: 1, reviewer: 1, qa: 1 });
    expect(stats.ticket_failures).toHaveLength(1);
    expect(stats.ticket_failures[0].task_id).toBe('T-3');
    expect(stats.unstaffed_role_fallbacks).toHaveLength(1);
    expect(stats.best_of_judgements).toBe(1);
    expect(stats.rework_events).toBe(1);
    expect(stats.goal_reconciliation_rounds).toBe(1);
    expect(stats.token_usage).toMatchObject({
      prompt_tokens: 110,
      completion_tokens: 45,
      total_tokens: 155,
      cost_usd: 0.01233,
      entries: 2,
    });
    expect(stats.token_usage.by_model['agy-runtime-model']).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(stats.resource_usage).toEqual({ entries: 1, cost_usd: 0.02 });
  });

  it('does not derive lifecycle stats from a schema-invalid mission state', () => {
    fs.writeFileSync(
      path.join(missionDir, 'mission-state.json'),
      JSON.stringify({
        mission_id: MISSION,
        context: {
          goal_reconciliation_round: 99,
          mission_finish_gate_last_reason: 'must not be reported',
        },
      })
    );

    const stats = mod.collectMissionExecutionStats(MISSION);

    expect(stats.goal_reconciliation_rounds).toBe(0);
    expect(stats.finish_gate_failures).toEqual([]);
  });

  it('fails closed when mission task or ticket manifest roots are malformed', () => {
    fs.writeFileSync(path.join(missionDir, 'NEXT_TASKS.json'), JSON.stringify({ tasks: [] }));
    fs.writeFileSync(
      path.join(missionDir, 'coordination', 'tickets', 'dispatch-manifest.json'),
      JSON.stringify({ mission_id: MISSION, records: 'invalid' })
    );

    const stats = mod.collectMissionExecutionStats(MISSION);

    expect(stats.task_total).toBe(0);
    expect(stats.tasks_by_role).toEqual({});
    expect(stats.ticket_failures).toEqual([]);
  });

  it('skips malformed JSONL records and does not count non-object events', () => {
    fs.writeFileSync(
      path.join(missionDir, 'coordination', 'events', 'task-events.jsonl'),
      [
        JSON.stringify([]),
        JSON.stringify(null),
        JSON.stringify({ decision: 'best_of_judged', payload: [] }),
        '{broken json',
      ].join('\n') + '\n'
    );

    const stats = mod.collectMissionExecutionStats(MISSION);
    expect(stats.best_of_judgements).toBe(1);
    expect(stats.rework_events).toBe(0);
    expect(stats.clarifications).toBe(0);
  });

  it('does not read symlinked mission telemetry into the retrospective', () => {
    const taskEventsPath = path.join(missionDir, 'coordination', 'events', 'task-events.jsonl');
    const externalEventsPath = path.join(tmpRoot, 'external-task-events.jsonl');
    fs.writeFileSync(
      externalEventsPath,
      JSON.stringify({ decision: 'best_of_judged', payload: {} }) + '\n'
    );
    fs.unlinkSync(taskEventsPath);
    fs.symlinkSync(externalEventsPath, taskEventsPath, 'file');

    try {
      const stats = mod.collectMissionExecutionStats(MISSION);
      expect(stats.best_of_judgements).toBe(0);
      expect(fs.existsSync(externalEventsPath)).toBe(true);
    } finally {
      fs.unlinkSync(taskEventsPath);
    }
  });

  it('fails closed when the process improvement queue is a symlink', () => {
    const queuePath = mod.processImprovementQueuePath();
    const externalQueuePath = path.join(tmpRoot, 'external-process-improvements.jsonl');
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(externalQueuePath, '');
    fs.symlinkSync(externalQueuePath, queuePath, 'file');

    try {
      expect(() => mod.listProcessImprovementProposals()).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.unlinkSync(queuePath);
      fs.unlinkSync(externalQueuePath);
    }
  });

  it('queues LLM proposals for operator ratification and notifies', async () => {
    backendPrompt.mockResolvedValue(
      JSON.stringify({
        proposals: [
          {
            kind: 'team_composition',
            target: 'team-blueprint',
            proposal: 'qa ロールを既定でスタッフィングする',
            rationale: 'ticket_failures に qa の agent_id 欠如が記録されている',
            evidence: ['ticket_failures[0]'],
          },
        ],
      })
    );
    const result = await mod.runMissionRetrospective(MISSION);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].status).toBe('proposed');
    expect(fs.existsSync(result.report_path)).toBe(true);
    expect(fs.readFileSync(result.report_path, 'utf8')).toContain('qa ロールを既定で');

    const queued = mod.listProcessImprovementProposals();
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('team_composition');
    expect(queued[0].mission_id).toBe(MISSION);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('question');
    // the prompt is grounded in the deterministic stats
    expect(String(backendPrompt.mock.calls[0][0])).toContain('EXECUTION STATS');
    expect(String(backendPrompt.mock.calls[0][0])).toContain('goal_reconciliation_rounds');
  });

  it('rejects malformed LLM proposal shapes and malformed queued records', async () => {
    backendPrompt.mockResolvedValue(
      JSON.stringify({
        proposals: [
          [],
          { proposal: 42 },
          { proposal: 'valid', kind: 'unknown', evidence: ['ok'] },
          { proposal: 'valid', kind: 'tooling', evidence: ['ok'] },
        ],
      })
    );
    const result = await mod.runMissionRetrospective(MISSION);
    expect(result.proposals).toHaveLength(1);

    const queuePath = mod.processImprovementQueuePath();
    fs.appendFileSync(queuePath, `${JSON.stringify([])}\n${JSON.stringify({ proposal: 'bad' })}\n`);
    expect(mod.listProcessImprovementProposals()).toHaveLength(1);
    expect(mod.normalizeProcessImprovementProposal([])).toBeUndefined();
  });

  it('rewrites queued proposals through the canonical schema boundary', async () => {
    backendPrompt.mockResolvedValue(
      JSON.stringify({
        proposals: [
          {
            kind: 'tooling',
            target: 'queue',
            proposal: 'queue schemaを適用する',
            rationale: 'durable queue contract',
            evidence: ['queue.jsonl'],
          },
        ],
      })
    );
    const result = await mod.runMissionRetrospective(MISSION);
    const queuePath = mod.processImprovementQueuePath();
    const proposal = result.proposals[0];
    fs.writeFileSync(
      queuePath,
      `${JSON.stringify({ $schema: 'https://example.invalid/proposal.json', ...proposal })}\n`
    );

    mod.decideProcessImprovementProposal(proposal.proposal_id, 'approved');

    const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8').trim());
    expect(persisted.$schema).toBeUndefined();
    expect(persisted.status).toBe('approved');
  });

  it('does not promote dangerous LLM proposal responses', async () => {
    backendPrompt.mockResolvedValue(
      '{"proposals":[{"kind":"tooling","proposal":"unsafe"}],"meta":{"__proto__":{}}}'
    );
    const result = await mod.runMissionRetrospective(MISSION);
    expect(result.proposals).toHaveLength(0);
  });

  it('records agent×role outcomes into the performance index and adjusts selection scores', async () => {
    // add outcomes to the dispatch manifest fixture
    fs.mkdirSync(path.join(missionDir, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(missionDir, 'evidence', 'workitem-dispatch-manifest.json'),
      JSON.stringify({
        mission_id: MISSION,
        records: Array.from({ length: 6 }, (_, index) => ({
          item_id: `witem-${index}`,
          team_role: 'implementer',
          assignee_peer_id: 'implementation-architect',
          provider: 'openai',
          model_id: 'openai:gpt-5.6-luna',
          work_item_status_after: index < 5 ? 'done' : 'blocked',
        })),
      })
    );
    backendName.value = 'stub';
    await mod.runMissionRetrospective(MISSION);

    const perf = await import('./agent-performance-index.js');
    perf.resetAgentPerformanceIndexCache();
    const record = perf.getAgentRolePerformance('implementation-architect', 'implementer');
    expect(record).toBeTruthy();
    expect(record!.samples).toBe(6);
    expect(record!.success).toBe(5);
    // 5/6 ≈ 0.83 → positive bounded bonus
    const bonus = perf.performanceScoreAdjustment('implementation-architect', 'implementer');
    expect(bonus).toBeGreaterThan(0);
    expect(bonus).toBeLessThanOrEqual(8);
    // below min samples → neutral
    expect(perf.performanceScoreAdjustment('unknown-agent', 'implementer')).toBe(0);

    const modelPerf = await import('./model-performance-index.js');
    modelPerf.resetModelPerformanceIndexCache();
    expect(modelPerf.getModelRolePerformance('openai:gpt-5.6-luna', 'implementer')).toMatchObject({
      samples: 6,
      success: 5,
      blocked: 1,
    });
    expect(
      modelPerf.modelPerformanceScoreAdjustment('openai:gpt-5.6-luna', 'implementer')
    ).toBeGreaterThan(0);
  });

  it('proposal lifecycle: approve → apply issues a work order; reject blocks apply', async () => {
    backendPrompt.mockResolvedValue(
      JSON.stringify({
        proposals: [
          {
            kind: 'workflow_rule',
            target: 'wf',
            proposal: 'ルールAを追加',
            rationale: 'r',
            evidence: [],
          },
          {
            kind: 'tooling',
            target: 'tool',
            proposal: 'ツールBを直す',
            rationale: 'r',
            evidence: [],
          },
        ],
      })
    );
    const result = await mod.runMissionRetrospective(MISSION);
    const [first, second] = result.proposals;

    const approved = mod.decideProcessImprovementProposal(first.proposal_id, 'approved');
    expect(approved.status).toBe('approved');
    const applied = mod.applyProcessImprovementProposal(first.proposal_id);
    expect(applied.proposal.status).toBe('applied');
    expect(fs.existsSync(applied.work_order_path)).toBe(true);
    expect(fs.readFileSync(applied.work_order_path, 'utf8')).toContain('ルールAを追加');

    const rejected = mod.decideProcessImprovementProposal(second.proposal_id, 'rejected');
    expect(rejected.status).toBe('rejected');
    expect(() => mod.applyProcessImprovementProposal(second.proposal_id)).toThrow(/approve/);

    const statuses = mod
      .listProcessImprovementProposals()
      .map((entry) => entry.status)
      .sort();
    expect(statuses).toEqual(['applied', 'rejected']);
  });

  it('degrades gracefully on stub backend: stats-only report, no proposals, no noise', async () => {
    backendName.value = 'stub';
    const result = await mod.runMissionRetrospective(MISSION);
    expect(result.proposals).toHaveLength(0);
    expect(backendPrompt).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(fs.readFileSync(result.report_path, 'utf8')).toContain('stub backend');
  });
});
