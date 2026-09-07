import { describe, expect, it } from 'vitest';
import { makeI18n } from '../i18n.js';
import { missionsViewModel } from './missions.js';
import { workViewModel, type WorkData } from './work.js';
import { schedulesViewModel, type SchedulesData } from './schedules.js';
import { settingsViewModel, type SettingsData } from './settings.js';
import { processesViewModel, heartbeatSummary, type ProcessesData } from './processes.js';
import { coordinationViewModel, type CoordinationData } from './coordination.js';
import { agentGraphViewModel, formatElapsedDuration, type AgentGraphData } from './agent-graph.js';
import type { CollaborationTree } from '@agent/core/agent-collaboration-tree';

const ja = makeI18n('ja');

describe('missionsViewModel', () => {
  it('maps mission summaries to rows with Japanese headers', () => {
    const vm = missionsViewModel(
      {
        missions: [
          {
            id: 'MSN-1',
            status: 'active',
            tier: 'personal',
            persona: 'worker',
            checkpoints: 2,
            lastEvent: 'START',
          },
        ],
      },
      ja
    );
    expect(vm.columns).toContain('状態');
    expect(vm.rows?.[0]?.cells).toEqual(['MSN-1', 'active', 'personal', 'worker', '2', 'START']);
  });
});

describe('workViewModel', () => {
  it('joins lease info into row detail', () => {
    const data = {
      items: [
        {
          item_id: 'witem-1',
          title: 'Fix things',
          description: 'desc',
          status: 'in_progress',
          priority: 'high',
          source: 'local',
          labels: ['a'],
          version: 3,
        },
      ],
      leases: [{ item_id: 'witem-1', holder_peer_id: 'peer-x', expires_at: '2026-01-01' }],
      boardCount: 1,
      sessionLines: [],
    } as unknown as WorkData;
    const vm = workViewModel(data, ja);
    expect(vm.rows?.[0]?.cells[2]).toBe('in_progress');
    const lease = vm.rows?.[0]?.detail?.find((line) => line.label === 'lease');
    expect(lease?.value).toContain('peer-x');
  });
});

describe('schedulesViewModel', () => {
  it('renders cron and due marker', () => {
    const data: SchedulesData = {
      schedules: [
        {
          id: 's1',
          name: 'daily',
          pipelinePath: 'pipelines/x.json',
          actuator: 'system',
          trigger: { type: 'cron', cron: '0 6 * * *' },
          enabled: true,
          due: true,
        } as SchedulesData['schedules'][number],
      ],
      generationLines: [],
    };
    const vm = schedulesViewModel(data, ja);
    expect(vm.rows?.[0]?.cells[1]).toBe('0 6 * * *');
    expect(vm.rows?.[0]?.cells[4]).toBe('●');
  });
});

describe('settingsViewModel', () => {
  it('lists reasoning backend and customer with change hints', () => {
    const data: SettingsData = {
      reasoningMode: 'claude-cli',
      customer: 'acme',
      profileRoot: '/p',
      rootDir: '/r',
    };
    const vm = settingsViewModel(data, ja);
    const reasoning = vm.rows?.find((row) => row.id === 'reasoning');
    expect(reasoning?.cells[1]).toBe('claude-cli');
    expect(reasoning?.cells[2]).toContain('pnpm reasoning:config');
  });
});

describe('processesViewModel', () => {
  it('renders running state and heartbeat section', () => {
    const data: ProcessesData = {
      processes: [
        {
          id: 'nexus-daemon',
          running: true,
          record: {
            id: 'nexus-daemon',
            pid: 123,
            resourceId: 'r',
            kind: 'service',
            command: 'node',
            args: ['x.js'],
            cwd: '/',
            logPath: '/tmp/none.log',
            startedAt: 'now',
            shutdownPolicy: 'manual',
          } as ProcessesData['processes'][number]['record'],
        },
      ],
      heartbeats: [
        { daemon_id: 'chronos-daemon', status: 'healthy' },
        { daemon_id: 'other', status: 'stale' },
      ] as ProcessesData['heartbeats'],
    };
    const vm = processesViewModel(data, ja);
    expect(vm.rows?.[0]?.cells[2]).toBe('稼働中');
    expect(vm.sections?.[0]?.lines[0]).toContain('chronos-daemon');
    expect(heartbeatSummary(data.heartbeats)).toEqual({ online: 1, total: 2 });
  });
});

describe('coordinationViewModel', () => {
  it('shows offline notice when supervisor daemon is unreachable', () => {
    const data: CoordinationData = {
      runtimes: null,
      providerLines: [],
      outboxLines: [],
      attention: [],
    };
    const vm = coordinationViewModel(data, ja);
    expect(vm.rows).toEqual([]);
    expect(vm.sections?.[0]?.lines[0]).toContain('スーパーバイザーデーモン停止中');
  });

  it('translates attention items by code and attaches next-action to the matching runtime row (AC-09)', () => {
    const data: CoordinationData = {
      runtimes: [
        { agent_id: 'agent-a', provider: 'claude-cli', status: 'running' },
      ] as CoordinationData['runtimes'],
      providerLines: [],
      outboxLines: [],
      attention: [
        {
          event_id: 'event-1',
          mission_id: 'MSN-1',
          agent_id: 'agent-a',
          kind: 'blocked',
          code: 'blocked',
          title: 'blocked',
          reason: 'work item is blocked',
          next_action: 'resolve the block',
        },
      ],
    };
    const vm = coordinationViewModel(data, ja);
    const label = ja.tr('tui:tui_attention_blocked');
    const attentionSection = vm.sections?.find((section) => section.lines[0]?.includes(label));
    expect(attentionSection?.lines[0]).toBe(
      `${label} · work item is blocked (mission=MSN-1 agent=agent-a)`
    );
    const detail = vm.rows?.[0]?.detail;
    expect(detail?.[0]?.value).toContain(ja.tr('tui:tui_attention_next_blocked'));
  });
});

describe('formatElapsedDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsedDuration(12000)).toBe('12s');
    expect(formatElapsedDuration(185000)).toBe('3m05s');
    expect(formatElapsedDuration(3720000)).toBe('1h02m');
  });

  it('falls back to a dash for missing durations', () => {
    expect(formatElapsedDuration(undefined)).toBe('-');
  });
});

function fixtureTree(): CollaborationTree {
  const child = {
    id: 'agent:A2',
    type: 'agent' as const,
    label: 'Sonnet',
    state: 'done',
    provider: 'claude-cli',
    team_role: 'reviewer',
    started_at: '2026-09-06T00:00:05.000Z',
    last_event_at: '2026-09-06T00:01:10.000Z',
    elapsed_ms: 65000,
    waiting_on: [],
    handoffs: [],
    children: [],
  };
  const parent = {
    id: 'agent:A1',
    type: 'agent' as const,
    label: 'Claude',
    state: 'running',
    provider: 'claude-cli',
    team_role: 'implementer',
    started_at: '2026-09-06T00:00:00.000Z',
    last_event_at: '2026-09-06T00:00:12.000Z',
    elapsed_ms: 12000,
    waiting_on: [
      {
        reason: 'child_running' as const,
        target_id: 'agent:A2',
        since: '2026-09-06T00:00:05.000Z',
      },
    ],
    handoffs: [
      { to_agent_id: 'agent:A2', performative: 'delegate', at: '2026-09-06T00:00:05.000Z' },
    ],
    children: [child],
  };
  const task = {
    id: 'task:T1',
    type: 'task' as const,
    label: 'Do work',
    state: 'in_progress',
    waiting_on: [],
    handoffs: [],
    children: [parent],
  };
  const mission = {
    id: 'mission:M1',
    type: 'mission' as const,
    label: 'M1',
    state: 'active',
    waiting_on: [],
    handoffs: [],
    children: [task],
  };
  return {
    generated_at: '2026-09-06T00:02:00.000Z',
    roots: [mission],
    orphans: [],
    waiting: [
      {
        node_id: 'agent:A1',
        reason: 'child_running',
        target_id: 'agent:A2',
        since: '2026-09-06T00:00:05.000Z',
      },
    ],
    stats: {
      missions: 1,
      tasks: 1,
      agents_total: 2,
      agents_running: 1,
      agents_waiting: 1,
      agents_done: 1,
      humans_waited_on: 0,
    },
  };
}

describe('agentGraphViewModel', () => {
  it('renders the tree pre-order with indentation and a spawned-child glyph', () => {
    const data: AgentGraphData = {
      tree: fixtureTree(),
      events: [],
      statusFlags: [],
      truncatedSources: [],
      peerTranscripts: [],
    };
    const vm = agentGraphViewModel(data, ja);
    expect(vm.rows?.map((row) => row.id)).toEqual([
      'mission:M1',
      'task:T1',
      'agent:A1',
      'agent:A2',
    ]);
    expect(vm.rows?.[0]?.cells[0]).toBe('◆ M1');
    expect(vm.rows?.[1]?.cells[0]).toBe('  ▸ Do work');
    expect(vm.rows?.[2]?.cells[0]).toBe('    ● Claude');
    // agent:A2's parent is agent:A1, not a task/mission - the spawned-child glyph.
    expect(vm.rows?.[3]?.cells[0]).toBe('      └● Sonnet');
  });

  it('formats the waiting cell with the translated reason and short target', () => {
    const data: AgentGraphData = {
      tree: fixtureTree(),
      events: [],
      statusFlags: [],
      truncatedSources: [],
      peerTranscripts: [],
    };
    const vm = agentGraphViewModel(data, ja);
    const parentRow = vm.rows?.find((row) => row.id === 'agent:A1');
    expect(parentRow?.cells[2]).toBe('子の完了待ち → A2');
    expect(parentRow?.color).toBe('yellow');
    const childRow = vm.rows?.find((row) => row.id === 'agent:A2');
    expect(childRow?.cells[2]).toBe('');
    expect(childRow?.cells[3]).toBe('1m05s');
    expect(childRow?.cells[4]).toBe('claude-cli/reviewer');
  });

  it('shows the bounded-read line only when the projection was truncated', () => {
    const data: AgentGraphData = {
      tree: fixtureTree(),
      events: [],
      statusFlags: ['bounded_read'],
      truncatedSources: ['worker-events-2026-09-04.jsonl'],
      peerTranscripts: [],
    };
    const vm = agentGraphViewModel(data, ja);
    const boundedLine = vm.sections
      ?.flatMap((section) => section.lines)
      .find((line) => line.includes('worker-events-2026-09-04.jsonl'));
    expect(boundedLine).toBeDefined();
  });

  it('renders an empty tree without rows and with the no-waiting placeholder', () => {
    const data: AgentGraphData = {
      tree: {
        generated_at: '2026-09-06T00:00:00.000Z',
        roots: [],
        orphans: [],
        waiting: [],
        stats: {
          missions: 0,
          tasks: 0,
          agents_total: 0,
          agents_running: 0,
          agents_waiting: 0,
          agents_done: 0,
          humans_waited_on: 0,
        },
      },
      events: [],
      statusFlags: [],
      truncatedSources: [],
      peerTranscripts: [],
    };
    const vm = agentGraphViewModel(data, ja);
    expect(vm.rows).toEqual([]);
    expect(vm.sections?.[0]?.lines).toEqual(['待ちはありません']);
  });

  it('translates activity-board blockers and the unassigned sentinel in node detail (AC-09)', () => {
    const data: AgentGraphData = {
      tree: fixtureTree(),
      events: [],
      statusFlags: [],
      truncatedSources: [],
      peerTranscripts: [],
      activityBoard: {
        generated_at: '2026-09-06T00:00:00.000Z',
        entries: [
          {
            agent_id: 'unassigned',
            item_id: 'witem-1',
            task_id: 'T1',
            title: 'Do work',
            status: 'backlog',
            blockers: [
              {
                kind: 'dependency',
                reason: 'Waiting on unfinished dependency tasks',
                dependency_ids: ['T0'],
              },
              { kind: 'unassigned', reason: 'No agent is assigned to this work item' },
            ],
            updated_at: '2026-09-06T00:00:00.000Z',
          },
        ],
        agents: [],
      },
    };
    const vm = agentGraphViewModel(data, ja);
    const taskRow = vm.rows?.find((row) => row.id === 'task:T1');
    const blockerValues = taskRow?.detail
      ?.filter((line) => line.label === 'blocker')
      .map((l) => l.value);
    expect(blockerValues).toEqual([
      ja.tr('tui:tui_blocker_dependency', { ids: 'T0' }),
      ja.tr('tui:tui_blocker_unassigned'),
    ]);
    const agentLine = taskRow?.detail?.find((line) => line.label === 'agent');
    expect(agentLine?.value).toBe(ja.tr('tui:tui_agent_unassigned'));
  });

  it('appends peer transcript tail lines to a matching agent node (AC-11)', () => {
    const data: AgentGraphData = {
      tree: fixtureTree(),
      events: [],
      statusFlags: [],
      truncatedSources: [],
      peerTranscripts: [
        {
          peer_id: 'Claude',
          remote_peer_id: 'peer-remote',
          session_id: 'sess-1',
          status: 'open',
          updated_at: '2026-09-06T00:00:10.000Z',
          lines: [
            {
              at: '2026-09-06T00:03:00.000Z',
              direction: 'outbound',
              sender_peer_id: 'Claude',
              text: 'hello',
            },
            {
              at: '2026-09-06T00:07:00.000Z',
              direction: 'inbound',
              sender_peer_id: 'peer-remote',
              text: 'hi back',
            },
          ],
        },
      ],
    };
    const vm = agentGraphViewModel(data, ja);
    const agentRow = vm.rows?.find((row) => row.id === 'agent:A1');
    const peerLines = agentRow?.detail
      ?.filter((line) => line.label === 'ピア会話')
      .map((l) => l.value);
    expect(peerLines).toEqual(['00:07 ← peer-remote: hi back', '00:03 → Claude: hello']);
  });
});
