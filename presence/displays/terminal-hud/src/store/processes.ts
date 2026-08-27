import {
  loadSurfaceManifest,
  loadSurfaceState,
  readSurfaceLogTail,
  listDaemonHeartbeatStatuses,
  pathResolver,
  type SurfaceRuntimeDefinition,
  type SurfaceRuntimeStateRecord,
  type DaemonHeartbeatStatus,
} from '@agent/core';
import { theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { DetailLine, PanelViewModel } from './types.js';

export interface ProcessRow {
  definition?: SurfaceRuntimeDefinition;
  record?: SurfaceRuntimeStateRecord;
  id: string;
  running: boolean;
}

export interface ProcessesData {
  processes: ProcessRow[];
  heartbeats: DaemonHeartbeatStatus[];
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function loadProcesses(): ProcessesData {
  let definitions: SurfaceRuntimeDefinition[] = [];
  let records: Record<string, SurfaceRuntimeStateRecord> = {};
  try {
    definitions = loadSurfaceManifest().surfaces;
  } catch {
    // missing manifest: fall back to state records only
  }
  try {
    records = loadSurfaceState().surfaces;
  } catch {
    // missing state file: all surfaces render as stopped
  }
  const ids = new Set<string>([...definitions.map((d) => d.id), ...Object.keys(records)]);
  const processes: ProcessRow[] = [...ids].map((id) => {
    const record = records[id];
    return {
      id,
      definition: definitions.find((d) => d.id === id),
      record,
      running: pidAlive(record?.pid),
    };
  });
  processes.sort((a, b) => Number(b.running) - Number(a.running) || a.id.localeCompare(b.id));
  let heartbeats: DaemonHeartbeatStatus[] = [];
  try {
    heartbeats = listDaemonHeartbeatStatuses();
  } catch {
    // heartbeat store may not exist yet
  }
  return { processes, heartbeats };
}

export function processesWatchPaths(): string[] {
  return [
    pathResolver.active('shared/runtime/surfaces/state.json'),
    pathResolver.active('shared/runtime/heartbeats'),
  ];
}

export function processDetail(row: ProcessRow, i18n: I18n): DetailLine[] {
  const lines: DetailLine[] = [
    {
      label: 'command',
      value: row.record
        ? `${row.record.command} ${row.record.args.join(' ')}`
        : (row.definition?.command ?? '-'),
    },
    { label: 'startedAt', value: row.record?.startedAt ?? '-' },
    { label: 'log', value: row.record?.logPath ?? '-' },
  ];
  if (row.record?.logPath) {
    for (const line of readSurfaceLogTail(row.record.logPath, 10)) {
      lines.push({ label: '│', value: line });
    }
  }
  return lines;
}

export function processesViewModel(data: ProcessesData, i18n: I18n): PanelViewModel {
  return {
    columns: [
      'ID',
      'kind',
      i18n.tr('tui:tui_mission_col_status'),
      'pid',
      i18n.tr('tui:tui_process_health'),
    ],
    rows: data.processes.map((row) => ({
      id: row.id,
      color: row.running ? theme.ok : theme.dim,
      cells: [
        row.id,
        String(row.record?.kind ?? row.definition?.kind ?? '-'),
        row.running ? i18n.tr('tui:tui_status_online') : i18n.tr('tui:tui_status_offline'),
        row.running && row.record ? String(row.record.pid) : '-',
        row.definition?.enabled === false ? 'disabled' : '',
      ],
    })),
    sections: [
      {
        title: i18n.tr('tui:tui_status_daemons'),
        lines:
          data.heartbeats.length > 0
            ? data.heartbeats.map(
                (hb) =>
                  `${hb.status === 'healthy' ? '●' : '○'} ${hb.daemon_id}  ${hb.status}${
                    hb.age_ms !== undefined ? `  ${Math.round(hb.age_ms / 1000)}s` : ''
                  }`
              )
            : [i18n.tr('tui:tui_empty')],
      },
    ],
  };
}

export function heartbeatSummary(heartbeats: DaemonHeartbeatStatus[]): {
  online: number;
  total: number;
} {
  return {
    online: heartbeats.filter((hb) => hb.status === 'healthy').length,
    total: heartbeats.length,
  };
}
