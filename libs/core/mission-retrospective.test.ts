import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realFsSecureIo = vi.hoisted(() => ({
  safeAppendFileSync: (filePath: string, data: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, data, 'utf8');
  },
  safeExistsSync: (filePath: string) => fs.existsSync(filePath),
  safeMkdir: (dirPath: string, options?: { recursive?: boolean }) =>
    fs.mkdirSync(dirPath, { recursive: options?.recursive !== false }),
  safeReadFile: (filePath: string, options: { encoding?: BufferEncoding | null } = {}) =>
    options.encoding === null ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8'),
  safeWriteFile: (filePath: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  },
}));
vi.mock('./secure-io.js', () => realFsSecureIo);
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
      JSON.stringify({ mission_id: MISSION, context: { goal_reconciliation_round: 1 } })
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

  it('records agent×role outcomes into the performance index and adjusts selection scores', async () => {
    // add outcomes to the dispatch manifest fixture
    fs.mkdirSync(path.join(missionDir, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(missionDir, 'evidence', 'workitem-dispatch-manifest.json'),
      JSON.stringify({
        records: Array.from({ length: 6 }, (_, index) => ({
          item_id: `witem-${index}`,
          team_role: 'implementer',
          assignee_peer_id: 'implementation-architect',
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
