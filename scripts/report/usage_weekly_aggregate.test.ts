import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  aggregateExecutionOrigins,
  aggregateUsageWeek,
  auditFileDatesForWindow,
  buildUsageWeeklyReport,
  executionOriginOf,
  type ExecutionMetricRecord,
  HOST_SUSPENDED_REASON,
  INTERACTIVE_CLI_TOKENS_OVERCOUNT,
  INTERACTIVE_CLI_TOKENS_UNAVAILABLE,
  normalizeTriggerFailureReason,
  readAuditRecordsForWindow,
  readExecutionMetricsForWindow,
  readSupervisorEventsForWindow,
  renderUsageWeeklyMarkdown,
  resolveUsageWeek,
  tenantsInText,
  type UsageAuditRecord,
} from './usage_weekly_aggregate.js';

const WEEK = resolveUsageWeek('2026-11-16');
const SECRET_PROMPT = 'confidential board numbers for tenant acme';

function rec(partial: Partial<UsageAuditRecord> & { at: string }): UsageAuditRecord {
  const { at, ...rest } = partial;
  return { agentId: 'claude_code', result: 'completed', timestamp: at, ...rest };
}

function hook(session: string, extra: Record<string, unknown> = {}) {
  return { session_hook: { host: 'claude', event: 'PostToolUse', session_id: session }, ...extra };
}

function fixture(): UsageAuditRecord[] {
  return [
    // Session A: touches a mission, 2 prompts, 3 tools, tenant path.
    rec({
      at: '2026-11-16T00:00:00Z',
      action: 'claude_code_user_prompt',
      metadata: hook('aaaaaaaa-1111', { cwd: '/repo', prompt_summary: SECRET_PROMPT }),
    }),
    rec({
      at: '2026-11-16T00:01:00Z',
      action: 'claude_code_tool',
      operation: 'Bash',
      metadata: hook('aaaaaaaa-1111', {
        tool: 'Bash',
        command: 'pnpm mission status MSN-FOO-20261116',
        cwd: '/repo',
      }),
    }),
    rec({
      at: '2026-11-16T00:02:00Z',
      action: 'claude_code_tool',
      operation: 'Write',
      metadata: hook('aaaaaaaa-1111', {
        tool: 'Write',
        file_path: '/repo/knowledge/confidential/acme/notes.md',
      }),
    }),
    rec({
      at: '2026-11-16T00:03:00Z',
      action: 'claude_code_tool',
      operation: 'Write',
      metadata: hook('aaaaaaaa-1111', {
        tool: 'Write',
        file_path: '/repo/knowledge/confidential/tenant-groups/x.json',
      }),
    }),
    rec({
      at: '2026-11-16T00:04:00Z',
      action: 'claude_code_user_prompt',
      metadata: hook('aaaaaaaa-1111', { cwd: '/repo', prompt_summary: SECRET_PROMPT }),
    }),
    // Session B: never touches a mission, 3 prompts.
    ...[0, 1, 2].map((i) =>
      rec({
        at: `2026-11-18T0${i}:00:00Z`,
        action: 'claude_code_user_prompt',
        metadata: hook('bbbbbbbb-2222', { cwd: '/repo', prompt_summary: SECRET_PROMPT }),
      })
    ),
    // Missions.
    rec({
      at: '2026-11-17T01:00:00Z',
      action: 'mission.lifecycle_verb',
      operation: 'create:MSN-MEETING-ACME-20261117',
    }),
    rec({
      at: '2026-11-17T01:05:00Z',
      action: 'mission.lifecycle_verb',
      operation: 'start:MSN-X-20261117',
    }),
    // Triggers: two host_suspended, one egress denial, one delivered.
    rec({
      at: '2026-11-19T00:00:00Z',
      action: 'trigger.failed',
      operation: 'wake:dot:repo-guardian:probe:1',
      result: 'error',
      reason:
        'wake tool loop exceeded its wall_clock budget before a backend turn completed; host suspended ~1781s during the wake — retried on the next sweep',
    }),
    rec({
      at: '2026-11-19T01:00:00Z',
      action: 'trigger.failed',
      operation: 'wake:dot:repo-guardian:probe:2',
      result: 'error',
      reason: 'wake tool loop exceeded; host suspended ~2000s during the wake',
    }),
    rec({
      at: '2026-11-19T02:00:00Z',
      action: 'trigger.failed',
      operation: 'cron:dot:acme-ops:cron:0 9 * * 1-5@x',
      result: 'error',
      reason:
        '[reasoning-backend:failover] generateWithTools failed across 1 candidate(s): claude-cli: [policy] [REASONING_EGRESS_DENIED] [TIER_EGRESS_DENIED] confidential material',
    }),
    rec({ at: '2026-11-19T03:00:00Z', action: 'trigger.delivered', operation: 'wake:dot:x' }),
    // Dot denial.
    rec({
      at: '2026-11-20T00:00:00Z',
      action: 'dot_action',
      operation: 'dot_delegate_work',
      result: 'denied',
      metadata: { dot_id: 'repo-guardian', reason: 'approval expired' },
    }),
    // Outside the JST window: Sunday 2026-11-15 23:59 JST and next Monday 00:00 JST.
    rec({ at: '2026-11-15T14:59:59Z', action: 'claude_code_user_prompt', metadata: hook('zzzz') }),
    rec({ at: '2026-11-22T15:00:00Z', action: 'claude_code_user_prompt', metadata: hook('zzzz') }),
  ];
}

describe('resolveUsageWeek', () => {
  it('uses JST Monday boundaries', () => {
    expect(new Date(WEEK.start_ms).toISOString()).toBe('2026-11-15T15:00:00.000Z');
    expect(new Date(WEEK.end_ms).toISOString()).toBe('2026-11-22T15:00:00.000Z');
  });

  it('defaults to the previous full week', () => {
    // Tuesday 2026-11-24 10:00 JST → week of Monday 2026-11-16.
    expect(resolveUsageWeek(undefined, new Date('2026-11-24T01:00:00Z')).week).toBe('2026-11-16');
    // Monday 2026-11-23 00:30 JST (still Sunday in UTC) → week of 2026-11-16.
    expect(resolveUsageWeek(undefined, new Date('2026-11-22T15:30:00Z')).week).toBe('2026-11-16');
  });

  it('rejects a non-Monday week', () => {
    expect(() => resolveUsageWeek('2026-11-17')).toThrow(/Monday/);
  });

  it('lists the UTC audit files that can hold the window', () => {
    expect(auditFileDatesForWindow(WEEK)).toEqual([
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
  });
});

describe('normalizeTriggerFailureReason', () => {
  it('splits host sleep out as host_suspended', () => {
    expect(normalizeTriggerFailureReason('budget exceeded; host suspended ~1781s')).toBe(
      HOST_SUSPENDED_REASON
    );
  });

  it('keeps governed error codes and the failover marker', () => {
    expect(
      normalizeTriggerFailureReason(
        '[reasoning-backend:failover] x: [policy] [REASONING_EGRESS_DENIED] [TIER_EGRESS_DENIED] y'
      )
    ).toBe('failover:REASONING_EGRESS_DENIED/TIER_EGRESS_DENIED');
    expect(normalizeTriggerFailureReason('[DOT_CREDENTIAL_GRANT_MISSING] tenant acme has no')).toBe(
      'DOT_CREDENTIAL_GRANT_MISSING'
    );
    expect(
      normalizeTriggerFailureReason(
        '[reasoning-backend:failover] x: claude-cli: [unknown] [shell-claude-cli] CLI exited with code 1.'
      )
    ).toBe('failover:cli_exit_nonzero');
  });
});

describe('tenantsInText', () => {
  it('extracts tenant slugs and skips shared prefixes', () => {
    expect(
      tenantsInText(
        'knowledge/confidential/acme/a knowledge/confidential/tenant-groups/b active/missions/confidential/beta/MSN-1/'
      ).sort()
    ).toEqual(['acme', 'beta']);
  });
});

describe('aggregateUsageWeek', () => {
  it('counts sessions, prompts, missions, triggers and denials inside the JST week only', () => {
    const summary = aggregateUsageWeek(fixture(), WEEK, 4);
    expect(summary.total_events).toBe(15);
    expect(summary.prompts).toBe(5);
    expect(summary.tool_events).toBe(3);
    expect(summary.sessions.count).toBe(2);
    expect(summary.sessions.long_sessions).toBe(1);
    expect(summary.sessions.top[0]).toMatchObject({
      session: 'aaaaaaaa',
      events: 5,
      prompts: 2,
      tool_events: 3,
      touched_mission: true,
    });
    expect(summary.tool_mix).toEqual([
      { key: 'Write', count: 2 },
      { key: 'Bash', count: 1 },
    ]);
    expect(summary.tenants_touched).toEqual([{ key: 'acme', count: 1 }]);
    expect(summary.missions).toMatchObject({
      created: 1,
      started: 1,
      created_families: [{ key: 'MSN-MEETING-ACME', count: 1 }],
    });
    expect(summary.prompts_outside_mission).toEqual({
      prompts: 3,
      sessions: 1,
      ratio: 3 / 5,
      unattributed_prompts: 0,
    });
    expect(summary.trigger).toMatchObject({
      delivered: 1,
      failed: 3,
      failed_excluding_host_suspended: 1,
      host_suspended: 2,
      by_source: [{ key: 'dot:acme-ops', count: 1 }],
    });
    expect(summary.dot_denials.by_reason).toEqual([
      { key: 'dot_delegate_work: approval_expired', count: 1 },
    ]);
    expect(summary.by_day.map((d) => d.day)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
  });
});

describe('buildUsageWeeklyReport + markdown', () => {
  it('derives improvement candidates and never copies prompt text', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      rec({
        at: `2026-11-17T0${i % 10}:${String(i).padStart(2, '0')}:00Z`,
        action: 'claude_code_user_prompt',
        metadata: hook('cccccccc-3333', { cwd: '/repo', prompt_summary: SECRET_PROMPT }),
      })
    );
    const report = buildUsageWeeklyReport({
      window: WEEK,
      current: [...fixture(), ...many],
      previous: [],
      now: new Date('2026-11-24T00:00:00Z'),
      longSessionThreshold: 4,
    });
    const ids = report.improvement_candidates.map((c) => c.id);
    expect(ids).toContain('long-sessions');
    expect(ids).toContain('work-outside-missions');
    expect(ids).not.toContain('host-suspended'); // only 2 < note threshold
    expect(ids.some((id) => id.includes(HOST_SUSPENDED_REASON))).toBe(false);

    const markdown = renderUsageWeeklyMarkdown(report);
    expect(markdown).toContain('# Kyberion usage — week of 2026-11-16 (JST)');
    expect(markdown).toContain('1 real failures + 2 host_suspended');
    expect(markdown).not.toContain(SECRET_PROMPT);
    expect(JSON.stringify(report)).not.toContain(SECRET_PROMPT);
  });
});

function metric(at: string, partial: Partial<ExecutionMetricRecord> = {}): ExecutionMetricRecord {
  return { timestamp: at, component: 'claude-cli', status: 'success', ...partial };
}

const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 50,
  cache_read_tokens: 80,
  cache_write_tokens: 5,
  cache_write_1h_tokens: 5,
};

function originFixture() {
  const audit: UsageAuditRecord[] = [
    rec({ at: '2026-11-16T00:00:00Z', agentId: 'claude-code', action: 'claude_code_tool' }),
    rec({ at: '2026-11-16T00:01:00Z', agentId: 'claude-code', action: 'claude_code_tool' }),
    rec({ at: '2026-11-16T00:02:00Z', agentId: 'dot:tenant-a-ops', action: 'dot_action' }),
    rec({
      at: '2026-11-16T00:03:00Z',
      agentId: 'chronos_gateway',
      action: 'trigger.failed',
      result: 'error',
    }),
    rec({ at: '2026-11-16T00:04:00Z', agentId: 'daemon_watchdog', action: 'daemon.tick' }),
    rec({ at: '2026-11-16T00:05:00Z', agentId: 'kyberion://agent/_/_/worker', action: 'x' }),
    rec({ at: '2026-11-16T00:06:00Z', agentId: 'tier-guard', action: 'x', result: 'denied' }),
    // Outside the window.
    rec({ at: '2026-11-15T14:00:00Z', agentId: 'claude-code', action: 'claude_code_tool' }),
  ];
  const metrics: ExecutionMetricRecord[] = [
    // Two wakes of one dot: 3 calls, one failed without usage.
    metric('2026-11-17T00:00:00Z', {
      actor_id: 'dot:tenant-a-ops',
      accounting_id: 'w1',
      usage: USAGE,
    }),
    metric('2026-11-17T00:00:01Z', {
      actor_id: 'dot:tenant-a-ops',
      accounting_id: 'w1',
      usage: USAGE,
    }),
    metric('2026-11-17T01:00:00Z', {
      actor_id: 'dot:tenant-a-ops',
      accounting_id: 'w2',
      status: 'error',
    }),
    metric('2026-11-17T02:00:00Z', {
      component: 'agent-runtime:ask',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }),
    metric('2026-11-17T03:00:00Z', { component: 'reasoning:route-served', operation: 'gen' }),
    metric('2026-11-17T03:00:01Z', {
      component: 'reasoning:route-failure',
      status: 'error',
      operation: 'gen',
    }),
    // Outside the window.
    metric('2026-11-22T15:00:00Z', { actor_id: 'dot:tenant-a-ops', accounting_id: 'w9' }),
  ];
  const supervisor = [
    { ts: '2026-11-18T00:00:00Z', decision: 'agent_runtime_supervisor_daemon_started' },
    {
      ts: '2026-11-18T00:00:00Z',
      decision: 'agent_runtime_supervisor_daemon_stopping',
      reason: 'process_exit',
    },
    {
      ts: '2026-11-18T01:00:00Z',
      decision: 'agent_runtime_ask_completed',
      input_tokens: 7,
      output_tokens: 3,
      usage_estimated: true,
    },
    { ts: '2026-11-18T02:00:00Z', decision: 'agent_runtime_ask_failed' },
  ];
  return { audit, metrics, supervisor };
}

describe('executionOriginOf', () => {
  it('splits interactive CLI, dots, triggers/daemons, agent runtimes and the rest', () => {
    expect(executionOriginOf('claude-code')).toBe('interactive_cli');
    expect(executionOriginOf('dot:tenant-a-ops')).toBe('dot');
    expect(executionOriginOf('chronos_gateway')).toBe('trigger_daemon');
    expect(executionOriginOf('organization_operator')).toBe('trigger_daemon');
    expect(executionOriginOf('kyberion://agent/_/_/worker')).toBe('agent_runtime');
    expect(executionOriginOf('tier-guard')).toBe('other');
    expect(executionOriginOf(undefined)).toBe('other');
  });
});

describe('aggregateExecutionOrigins', () => {
  it('counts audit events, LLM calls, tokens, cache hit and per-wake calls inside the window', () => {
    const summary = aggregateExecutionOrigins({ window: WEEK, ...originFixture() });
    expect(summary.sources).toEqual({
      audit_records: 7,
      execution_metrics_records: 6,
      supervisor_events: 4,
    });
    const by = Object.fromEntries(summary.by_origin.map((r) => [r.origin, r]));
    expect(by.interactive_cli).toMatchObject({
      audit_events: 2,
      llm_calls: 0,
      tokens: null,
      token_note: INTERACTIVE_CLI_TOKENS_UNAVAILABLE,
    });
    expect(by.dot).toMatchObject({
      audit_events: 1,
      llm_calls: 3,
      llm_failures: 1,
      tokens: {
        input_tokens: 200, // 2 × (10 + 80 + 5 + 5)
        output_tokens: 100,
        cache_read_tokens: 160,
        cache_hit_ratio: 0.8,
      },
    });
    expect(by.trigger_daemon).toMatchObject({ audit_events: 2, audit_failures: 1, llm_calls: 0 });
    expect(by.agent_runtime).toMatchObject({
      audit_events: 1,
      llm_calls: 1,
      tokens: { input_tokens: 7, output_tokens: 3, cache_hit_ratio: null },
    });
    expect(by.other).toMatchObject({ audit_events: 1, audit_failures: 0 });
    expect(summary.trigger_daemon_agents).toEqual([
      { key: 'chronos_gateway', count: 1 },
      { key: 'daemon_watchdog', count: 1 },
    ]);
    expect(summary.dots).toEqual([
      expect.objectContaining({
        dot: 'dot:tenant-a-ops',
        audit_events: 1,
        llm_calls: 3,
        llm_failures: 1,
        wakes: 2,
        calls_per_wake: 1.5,
      }),
    ]);
    expect(summary.reasoning_routes).toEqual([
      { key: 'reasoning:route-failure (error)', count: 1 },
      { key: 'reasoning:route-served (success)', count: 1 },
    ]);
    expect(summary.supervisor).toEqual({
      asks_completed: 1,
      asks_failed: 1,
      ask_input_tokens: 7,
      ask_output_tokens: 3,
      asks_usage_estimated: 1,
      daemon_started: 1,
      daemon_stops_by_reason: [{ key: 'process_exit', count: 1 }],
    });
  });

  it('uses interactive Stop-hook rows when present and labels them as over-counted', () => {
    const summary = aggregateExecutionOrigins({
      window: WEEK,
      audit: [],
      metrics: [
        metric('2026-11-17T00:00:00Z', {
          component: 'claude-code-cli',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      ],
      supervisor: [],
    });
    const cli = summary.by_origin.find((r) => r.origin === 'interactive_cli')!;
    expect(cli).toMatchObject({
      llm_calls: 1,
      tokens: { input_tokens: 100, output_tokens: 20, cache_hit_ratio: null },
      token_note: INTERACTIVE_CLI_TOKENS_OVERCOUNT,
    });
  });

  it('reads post-fix Stop-hook cache counters beside usage without the over-count note', () => {
    const summary = aggregateExecutionOrigins({
      window: WEEK,
      audit: [],
      metrics: [
        metric('2026-11-17T00:00:00Z', {
          component: 'claude-code-cli',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          cache_read_tokens: 900,
          cache_creation_tokens: 40,
        }),
      ],
      supervisor: [],
    });
    const cli = summary.by_origin.find((r) => r.origin === 'interactive_cli')!;
    expect(cli.tokens).toMatchObject({
      input_tokens: 1000,
      output_tokens: 20,
      cache_hit_ratio: 0.9,
    });
    expect(cli.token_note).toBeUndefined();
  });

  it('renders the section in Markdown and carries it in the JSON report', () => {
    const { audit, metrics, supervisor } = originFixture();
    const report = buildUsageWeeklyReport({
      window: WEEK,
      current: audit,
      previous: [],
      metrics,
      supervisor,
      now: new Date('2026-11-24T00:00:00Z'),
    });
    expect(report.execution_origin.by_origin.map((r) => r.origin)).toEqual([
      'interactive_cli',
      'dot',
      'trigger_daemon',
      'agent_runtime',
      'other',
    ]);
    const markdown = renderUsageWeeklyMarkdown(report);
    expect(markdown).toContain('## Execution origin (実行元)');
    expect(markdown).toContain(
      `| interactive_cli | 2 | 0 | 0 | 0 | ${INTERACTIVE_CLI_TOKENS_UNAVAILABLE} | ${INTERACTIVE_CLI_TOKENS_UNAVAILABLE} | - |`
    );
    expect(markdown).toContain('| dot | 1 | 0 | 3 | 1 | 200 | 100 | 80% |');
    expect(markdown).toContain('| dot:tenant-a-ops | 1 | 3 | 1 | 2 | 1.5 | 200 | 100 | 80% |');
    expect(markdown).toContain('| process_exit | 1 |');
  });

  it('defaults to empty metrics/supervisor input', () => {
    const report = buildUsageWeeklyReport({ window: WEEK, current: [], previous: [] });
    expect(report.execution_origin.sources.execution_metrics_records).toBe(0);
    expect(report.execution_origin.dots).toEqual([]);
  });
});

describe('readExecutionMetricsForWindow + readSupervisorEventsForWindow', () => {
  let dir: string;

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`usage-weekly-origin-test-${process.pid}-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
  });

  afterEach(() => {
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('reads the system ledger plus partitions and the dated supervisor files inside the window', () => {
    const file = path.join(dir, 'execution-metrics.jsonl');
    safeWriteFile(
      file,
      [
        JSON.stringify(metric('2026-11-15T14:00:00Z', { actor_id: 'before' })),
        JSON.stringify(metric('2026-11-16T00:00:00Z', { actor_id: 'system' })),
        '{not json',
      ].join('\n') + '\n'
    );
    const partitionRoot = path.join(dir, 'partitions');
    safeMkdir(path.join(partitionRoot, 'public', 'shared'), { recursive: true });
    safeWriteFile(
      path.join(partitionRoot, 'public', 'shared', 'execution-metrics.jsonl'),
      `${JSON.stringify(metric('2026-11-20T00:00:00Z', { actor_id: 'partition' }))}\n`
    );
    const rows = readExecutionMetricsForWindow(WEEK, { file, partitionRoot });
    expect(rows.map((r) => r.actor_id)).toEqual(['system', 'partition']);

    safeWriteFile(
      path.join(dir, 'agent-runtime-supervisor-events-2026-11-22.jsonl'),
      [
        JSON.stringify({ ts: '2026-11-22T14:00:00Z', decision: 'inside' }),
        JSON.stringify({ ts: '2026-11-22T15:00:00Z', decision: 'after' }),
      ].join('\n') + '\n'
    );
    expect(readSupervisorEventsForWindow(WEEK, dir).map((r) => r.decision)).toEqual(['inside']);
  });

  it('returns nothing when the sources do not exist', () => {
    expect(
      readExecutionMetricsForWindow(WEEK, {
        file: path.join(dir, 'missing.jsonl'),
        partitionRoot: path.join(dir, 'missing'),
      })
    ).toEqual([]);
    expect(readSupervisorEventsForWindow(WEEK, path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('readAuditRecordsForWindow', () => {
  let dir: string;

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`usage-weekly-test-${process.pid}-${Date.now()}`);
    safeMkdir(dir, { recursive: true });
  });

  afterEach(() => {
    if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('reads the UTC-dated files, filters to the window, and skips malformed lines', () => {
    const lines = (rows: UsageAuditRecord[]) => rows.map((r) => JSON.stringify(r)).join('\n');
    safeWriteFile(
      path.join(dir, 'audit-2026-11-15.jsonl'),
      `${lines([
        rec({ at: '2026-11-15T14:00:00Z', action: 'before' }),
        rec({ at: '2026-11-15T16:00:00Z', action: 'inside' }),
      ])}\n{not json\n`
    );
    safeWriteFile(
      path.join(dir, 'audit-2026-11-22.jsonl'),
      `${lines([
        rec({ at: '2026-11-22T14:59:00Z', action: 'inside' }),
        rec({ at: '2026-11-22T15:00:00Z', action: 'after' }),
      ])}\n`
    );
    const records = readAuditRecordsForWindow(WEEK, dir);
    expect(records.map((r) => r.action)).toEqual(['inside', 'inside']);
  });
});
