import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  conversation: vi.fn(() => [] as unknown[]),
  approval: vi.fn(() => null as unknown),
  workerEvents: vi.fn(() => [] as unknown[]),
  failoverPath: { value: '' },
  history: vi.fn(() => [] as unknown[]),
  usage: vi.fn(() => [] as unknown[]),
  healthSamples: vi.fn(() => [] as unknown[]),
  peerTenants: vi.fn(() => [] as string[]),
  peerPeers: vi.fn(() => [] as string[]),
  peerSessions: vi.fn(() => [] as unknown[]),
  rooms: vi.fn(() => [] as unknown[]),
  roomEvents: vi.fn(() => [] as unknown[]),
  room: vi.fn(() => null as unknown),
  quarantine: vi.fn(() => [] as unknown[]),
  sessions: vi.fn(() => [] as unknown[]),
}));

vi.mock('../intent/conversation-signals.js', () => ({
  listConversationSignals: mocks.conversation,
}));
vi.mock('../governance/approval-store.js', () => ({ loadApprovalRequest: mocks.approval }));
vi.mock('../workforce/worker-event-stream.js', () => ({
  readWorkerEventStreamJsonl: mocks.workerEvents,
}));
vi.mock('../reasoning/reasoning-failover.js', () => ({
  reasoningFailoverEventsPath: () => mocks.failoverPath.value,
}));
vi.mock('../metrics.js', () => ({
  metrics: { loadHistory: mocks.history, loadResourceUsageHistory: mocks.usage },
}));
vi.mock('../tool/runtime-health-history.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadRuntimeHealthSamples: mocks.healthSamples,
}));
vi.mock('../mesh/peer-conversation.js', () => ({
  listPeerConversationTenants: mocks.peerTenants,
  listPeerConversationPeers: mocks.peerPeers,
  listPeerConversationSessions: mocks.peerSessions,
}));
vi.mock('../discussion/discussion-store.js', () => ({
  listDiscussionRooms: mocks.rooms,
  readDiscussionEvents: mocks.roomEvents,
  readDiscussionRoom: mocks.room,
}));
vi.mock('../security-screen.js', () => ({ listQuarantineRecords: mocks.quarantine }));
vi.mock('../task/task-session.js', () => ({ listTaskSessions: mocks.sessions }));

import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  adfRepairSource,
  approvalRejectionSource,
  auditDenialSource,
  builtinLearningSignalSources,
  collaborationSource,
  conversationSignalSource,
  defectSource,
  delegationFailureSource,
  detectCostSpikes,
  executionMetricSource,
  quarantineSource,
  reasoningFailoverSource,
  runtimeHealthSource,
  taskSessionFailureSource,
  traceFailureSource,
  workerEventSource,
} from './learning-signal-sources.js';

const WINDOW = {
  since: new Date('2026-10-01T00:00:00.000Z'),
  until: new Date('2026-10-02T00:00:00.000Z'),
};
const IN = '2026-10-01T12:00:00.000Z';
const OUT = '2026-09-20T12:00:00.000Z';

let root: string;
const originalShared = pathResolver.shared;

function writeJsonl(relative: string, rows: unknown[]): string {
  const filePath = path.join(root, relative);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return filePath;
}

beforeEach(() => {
  root = pathResolver.sharedTmp(
    `learning-signal-sources-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  safeMkdir(root, { recursive: true });
  vi.spyOn(pathResolver, 'shared').mockImplementation((sub = '') => path.join(root, sub));
  for (const fn of Object.values(mocks)) if (typeof fn === 'function') fn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  pathResolver.shared = originalShared;
  delete process.env.KYBERION_DELEGATION_TRACE_PATH;
  if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
});

describe('built-in learning-signal sources (LS-02)', () => {
  it('keeps free text out of the keys of hint-producing sources', () => {
    writeJsonl('logs/traces/traces-2026-10-01.jsonl', [
      {
        traceId: 'leak',
        metadata: { startedAt: IN, pipelineId: 'Acme Corp board deck' },
        rootSpan: {
          name: 'x',
          status: 'error',
          error: "not found in knowledge/confidential/acme/plan.md for customer 'acme'",
          children: [],
        },
      },
    ]);
    const [row] = traceFailureSource.read(WINDOW);
    expect(row.key).toBe('x:not_found');
    expect(JSON.stringify(row)).not.toContain('acme');
  });

  it('registers one source per previously dead-ended log', () => {
    expect(builtinLearningSignalSources().map((source) => source.id)).toEqual([
      'conversation',
      'approval-rejection',
      'trace-failure',
      'task-session',
      'adf-repair',
      'delegation',
      'audit-denial',
      'worker-event',
      'reasoning-failover',
      'execution-metric',
      'defect',
      'runtime-health',
      'collaboration',
      'quarantine',
    ]);
  });

  it('clusters conversation misses by kind, intent and locale', () => {
    mocks.conversation.mockReturnValue([
      { signal_id: 's1', ts: IN, kind: 'turn_failed', intent_id: 'book-meeting', locale: 'ja' },
      { signal_id: 's2', ts: IN, kind: 'route_unrecognized', surface: 'slack', excerpt: 'secret' },
    ]);
    const rows = conversationSignalSource.read(WINDOW);
    expect(mocks.conversation).toHaveBeenCalledWith(
      expect.objectContaining({ sinceMs: WINDOW.since.getTime() })
    );
    expect(rows.map((row) => row.key)).toEqual([
      'turn_failed:book-meeting:ja',
      'route_unrecognized:slack:any',
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('reads rejections on every approval channel with their reason and tenant', () => {
    writeJsonl('observability/channels/slack/approvals.jsonl', [
      { ts: IN, event: 'rejected', request_id: 'r1', reason_category: 'scope' },
      { ts: IN, event: 'approved', request_id: 'r2' },
      { ts: OUT, event: 'rejected', request_id: 'r3' },
    ]);
    writeJsonl('observability/channels/terminal/approvals.jsonl', [
      { ts: IN, event: 'rejected', request_id: 'r4' },
    ]);
    mocks.approval.mockImplementation((channel: string, id: string) =>
      id === 'r1'
        ? { kind: 'deploy', scope: { tenant_slug: 'acme' } }
        : {
            kind: 'send_mail',
            workflow: { approvals: [{ status: 'rejected', reasonCategory: 'quality' }] },
          }
    );
    const rows = approvalRejectionSource.read(WINDOW);
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'deploy:scope',
        ref: 'approval:slack/r1',
        tenantSlug: 'acme',
      }),
      expect.objectContaining({ key: 'send_mail:quality', ref: 'approval:terminal/r4' }),
    ]);
    expect(rows[1].tenantSlug).toBeUndefined();
  });

  it('reads failed spans of runs outside missions only', () => {
    const failing = (traceId: string, metadata: Record<string, unknown>) => ({
      traceId,
      metadata: { startedAt: IN, ...metadata },
      rootSpan: {
        name: 'pipeline',
        status: 'error',
        children: [
          {
            name: 'browser:click',
            status: 'error',
            error: 'Timeout 30000ms exceeded',
            children: [],
          },
        ],
      },
    });
    writeJsonl('logs/traces/traces-2026-10-01.jsonl', [
      failing('t1', { pipelineId: 'daily-report' }),
      failing('t2', { pipelineId: 'daily-report', missionId: 'MSN-X' }),
      failing('t3', { pipelineId: 'daily-report', origin: 'test' }),
      {
        traceId: 't4',
        metadata: { startedAt: IN },
        rootSpan: { name: 'ok', status: 'ok', children: [] },
      },
    ]);
    const rows = traceFailureSource.read(WINDOW);
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'browser:click:timeout',
        ref: 'trace:t1',
      }),
    ]);
  });

  it('reads failed task sessions in the window', () => {
    mocks.sessions.mockReturnValue([
      {
        session_id: 'a',
        status: 'failed',
        updated_at: IN,
        task_type: 'report',
        payload: { intent_id: 'weekly' },
      },
      { session_id: 'b', status: 'completed', updated_at: IN, task_type: 'report', payload: {} },
      {
        session_id: 'c',
        status: 'failed',
        updated_at: IN,
        task_type: 'mail',
        payload: {},
        project_context: { tenant_slug: 'acme' },
      },
    ]);
    expect(taskSessionFailureSource.read(WINDOW)).toEqual([
      expect.objectContaining({ key: 'report:weekly', ref: 'task-session:a' }),
      expect.objectContaining({ key: 'mail:no-intent', tenantSlug: 'acme' }),
    ]);
  });

  it('splits ADF repairs from other delegations', () => {
    process.env.KYBERION_DELEGATION_TRACE_PATH = writeJsonl('observability/delegations.jsonl', [
      { trace_id: 'd1', owner: 'adf-repair-agent', status: 'started', created_at: IN },
      {
        trace_id: 'd1',
        owner: 'adf-repair-agent',
        status: 'completed',
        created_at: IN,
        completed_at: IN,
        context: 'steps/2/op: must be string',
      },
      {
        trace_id: 'd2',
        owner: 'adf-repair-agent',
        status: 'failed',
        completed_at: IN,
        context: 'JSON parse error: Unexpected token',
        error: 'unparseable',
      },
      {
        trace_id: 'd5',
        owner: 'adf-repair-agent',
        status: 'completed',
        completed_at: IN,
        context: 'steps/0/op: must be equal to one of the allowed values',
        result_summary: 'repair completed but validation still failed: steps/0/op',
      },
      {
        trace_id: 'd3',
        owner: 'planner',
        status: 'failed',
        completed_at: IN,
        backend_name: 'codex',
        error: 'rate limited',
      },
      { trace_id: 'd4', owner: 'planner', status: 'completed', completed_at: IN },
    ]);
    expect(adfRepairSource.read(WINDOW).map((row) => row.key)).toEqual([
      'repaired:type_mismatch',
      'failed:json_parse',
      'failed:enum_violation',
    ]);
    expect(delegationFailureSource.read(WINDOW).map((row) => row.key)).toEqual([
      'planner:codex:rate_limited',
    ]);
  });

  it('reads denied and failed audit entries', () => {
    writeJsonl('logs/audit/audit-2026-10-01.jsonl', [
      {
        id: 'a1',
        timestamp: IN,
        action: 'policy_evaluation',
        operation: 'write /repo/knowledge/x.md',
        result: 'denied',
        metadata: { policy: 'tier-guard' },
      },
      { id: 'a2', timestamp: IN, action: 'tool', operation: 'run', result: 'allowed' },
      {
        id: 'a3',
        timestamp: IN,
        action: 'tool',
        operation: 'run',
        result: 'failed',
        tenantSlug: 'acme',
      },
    ]);
    expect(auditDenialSource.read(WINDOW)).toEqual([
      expect.objectContaining({ key: 'policy_evaluation:write:denied:tier-guard' }),
      expect.objectContaining({ key: 'tool:run:failed', tenantSlug: 'acme' }),
    ]);
  });

  it('reads failed steps and unavailable sub-agents from the worker stream', () => {
    // Named after the day the process started, still appended to inside the window.
    writeJsonl('logs/worker-events/worker-events-2026-09-01.jsonl', [{}]);
    mocks.workerEvents.mockReturnValue([
      {
        type: 'step_end',
        ts: IN,
        seq: 1,
        payload: { op: 'system:exec', status: 'failed', error: 'exit 1' },
      },
      { type: 'step_end', ts: IN, seq: 2, payload: { op: 'system:exec', status: 'success' } },
      { type: 'subagent_unavailable', ts: IN, seq: 3, payload: { provider: 'gemini' } },
    ]);
    expect(workerEventSource.read(WINDOW).map((row) => row.key)).toEqual([
      'step_failed:system:exec:error',
      'subagent_unavailable:gemini',
    ]);
  });

  it('reads reasoning failovers', () => {
    mocks.failoverPath.value = writeJsonl('runtime/reasoning-failover-events.jsonl', [
      {
        ts: IN,
        from_mode: 'claude-agent',
        to_mode: 'claude-cli',
        method: 'delegateTask',
        error_summary: '429 Too Many Requests',
      },
    ]);
    expect(reasoningFailoverSource.read(WINDOW).map((row) => row.key)).toEqual([
      'claude-agent->claude-cli:http_429',
    ]);
  });

  it('flags metric errors, latency outliers and cost spikes outside missions', () => {
    mocks.history.mockReturnValue([
      ...Array.from({ length: 5 }, () => ({
        component: 'render',
        duration_ms: 10_000,
        status: 'success',
        timestamp: OUT,
      })),
      { component: 'render', duration_ms: 90_000, status: 'success', timestamp: IN },
      {
        component: 'render',
        duration_ms: 1,
        status: 'error',
        timestamp: IN,
        error: 'canvas 3 missing',
      },
      { component: 'render', duration_ms: 1, status: 'error', timestamp: IN, mission_id: 'MSN-1' },
    ]);
    mocks.usage.mockReturnValue([
      { source: 'llm-gateway', timestamp: '2026-09-28T00:00:00Z', cost_usd: 2 },
      { source: 'llm-gateway', timestamp: '2026-09-29T00:00:00Z', cost_usd: 2 },
      { source: 'llm-gateway', timestamp: IN, cost_usd: 9 },
    ]);
    expect(executionMetricSource.read(WINDOW).map((row) => row.key)).toEqual([
      'slow:render',
      'error:render:error',
      'cost_spike:llm-gateway',
    ]);
  });

  it('ignores a cost day that stays near its median', () => {
    expect(
      detectCostSpikes(
        [
          { source: 's', timestamp: '2026-09-29T00:00:00Z', cost_usd: 5 } as never,
          { source: 's', timestamp: IN, cost_usd: 6 } as never,
        ],
        WINDOW
      )
    ).toEqual([]);
  });

  it('reads reopened defects', () => {
    writeJsonl('runtime/qa/defect-events.jsonl', [
      {
        defect_id: 'D-1',
        from: 'fixed',
        to: 'reopened',
        actor_id: 'qa',
        actor_type: 'human',
        reason: 'still broken',
        evidence_refs: [],
        occurred_at: IN,
      },
      {
        defect_id: 'D-2',
        from: 'open',
        to: 'fixed',
        actor_id: 'dev',
        actor_type: 'human',
        reason: 'done',
        evidence_refs: [],
        occurred_at: IN,
      },
    ]);
    expect(defectSource.read(WINDOW).map((row) => row.key)).toEqual(['reopened:human']);
  });

  it('turns runtime health trends into observations', () => {
    mocks.healthSamples.mockReturnValue([
      { timestamp: '2026-10-01T00:30:00Z', process_name: 'chronos', rss_mb: 100, heap_used_mb: 50 },
      { timestamp: '2026-10-01T01:00:00Z', process_name: 'chronos', rss_mb: 100, heap_used_mb: 50 },
      { timestamp: '2026-10-01T20:00:00Z', process_name: 'chronos', rss_mb: 300, heap_used_mb: 50 },
    ]);
    expect(runtimeHealthSource.read(WINDOW)).toEqual([
      expect.objectContaining({
        key: 'rss_growth:chronos',
        ts: '2026-10-01T20:00:00Z',
        ref: 'runtime-health:chronos:rss_growth:2026-10-01',
      }),
    ]);
    expect(mocks.healthSamples).toHaveBeenCalledWith(86_400_000, WINDOW.until.getTime());
  });

  it('reads peer, discussion and co-session failures', () => {
    mocks.peerTenants.mockReturnValue(['acme']);
    mocks.peerPeers.mockReturnValue(['local']);
    mocks.peerSessions.mockReturnValue([
      { session_id: 'p1', status: 'failed', remote_peer_id: 'remote-a', updated_at: IN },
      { session_id: 'p2', status: 'active', remote_peer_id: 'remote-a', updated_at: IN },
    ]);
    mocks.rooms.mockReturnValue([{ id: 'room-1' }]);
    mocks.room.mockReturnValue({ scope: {} });
    mocks.roomEvents.mockReturnValue([
      { seq: 1, ts: IN, type: 'error', message: 'model crashed' },
      { seq: 2, ts: IN, type: 'review_recorded', verdict: 'reject', actor: 'u' },
      { seq: 3, ts: IN, type: 'review_recorded', verdict: 'accept', actor: 'u' },
    ]);
    writeJsonl('observability/co-sessions/cs-1/events.jsonl', [
      { event_id: 'e1', type: 'lease_expired', at: IN, actor_provider: 'codex' },
      { event_id: 'e2', type: 'lease_acquired', at: IN, actor_provider: 'codex' },
    ]);
    expect(collaborationSource.read(WINDOW)).toEqual([
      expect.objectContaining({ key: 'peer:failed:remote-a', tenantSlug: 'acme' }),
      expect.objectContaining({ key: 'discussion:error' }),
      expect.objectContaining({ key: 'discussion:review_reject' }),
      expect.objectContaining({ key: 'co-session:lease_expired:codex' }),
    ]);
  });

  it('groups quarantined content by source and indicators, never by content', () => {
    mocks.quarantine.mockReturnValue([
      {
        id: 'q1',
        recorded_at: IN,
        source: 'web',
        indicators: ['role_override', 'exfil'],
        content: 'ignore all previous',
        reason: 'x',
      },
    ]);
    const rows = quarantineSource.read(WINDOW);
    expect(rows.map((row) => row.key)).toEqual(['web:exfil+role_override']);
    mocks.quarantine.mockReturnValue([
      {
        id: 'q2',
        recorded_at: IN,
        source: 'https://evil.example/x',
        scope: 'acme',
        indicators: [],
        content: '',
        reason: 'x',
      },
    ]);
    expect(quarantineSource.read(WINDOW)).toEqual([
      expect.objectContaining({ key: 'external:unspecified', tenantSlug: 'acme' }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('ignore all previous');
  });
});
