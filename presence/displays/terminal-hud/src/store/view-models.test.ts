import { describe, expect, it } from 'vitest';
import { makeI18n } from '../i18n.js';
import { missionsViewModel } from './missions.js';
import { workViewModel, type WorkData } from './work.js';
import { schedulesViewModel, type SchedulesData } from './schedules.js';
import { settingsViewModel, type SettingsData } from './settings.js';
import { processesViewModel, heartbeatSummary, type ProcessesData } from './processes.js';
import { coordinationViewModel, type CoordinationData } from './coordination.js';

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
      attentionLines: [],
    };
    const vm = coordinationViewModel(data, ja);
    expect(vm.rows).toEqual([]);
    expect(vm.sections?.[0]?.lines[0]).toContain('スーパーバイザーデーモン停止中');
  });
});
