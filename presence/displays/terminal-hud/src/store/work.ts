import {
  listWorkItems,
  listActiveWorkLeases,
  listBoards,
  type WorkItem,
  type WorkLease,
} from '@agent/core/work-coordination';
import { listTaskSessions } from '@agent/core/task-session';
import { pathResolver } from '@agent/core/path-resolver';
import { statusColor } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

export interface WorkData {
  items: WorkItem[];
  leases: WorkLease[];
  boardCount: number;
  sessionLines: string[];
}

const STATUS_ORDER = ['in_progress', 'ready', 'review', 'blocked', 'backlog', 'done', 'archived'];

export function loadWork(): WorkData {
  const items = listWorkItems({}).sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  );
  let sessionLines: string[] = [];
  try {
    sessionLines = listTaskSessions()
      .slice(-5)
      .map((session: any) =>
        [session.session_id ?? session.id ?? '?', session.surface ?? '', session.status ?? ''].join(
          '  '
        )
      );
  } catch {
    // task sessions are optional context; ignore load failures
  }
  return {
    items,
    leases: listActiveWorkLeases(),
    boardCount: listBoards().length,
    sessionLines,
  };
}

export function workWatchPaths(): string[] {
  return [
    pathResolver.active('shared/runtime/work-coordination'),
    pathResolver.active('shared/runtime/task-sessions'),
  ];
}

export function workViewModel(data: WorkData, i18n: I18n): PanelViewModel {
  const leaseByItem = new Map(data.leases.map((lease) => [lease.item_id, lease]));
  return {
    columns: [
      'ID',
      i18n.tr('tui:tui_detail_title'),
      i18n.tr('tui:tui_mission_col_status'),
      i18n.tr('tui:tui_task_col_priority'),
      i18n.tr('tui:tui_task_col_assignee'),
    ],
    rows: data.items.map((item) => {
      const lease = leaseByItem.get(item.item_id);
      return {
        id: item.item_id,
        color: statusColor(item.status),
        cells: [
          item.item_id,
          item.title,
          item.status,
          item.priority,
          item.assignee_peer_id ?? item.claimed_by_peer_id ?? '-',
        ],
        detail: [
          { label: 'title', value: item.title },
          { label: 'description', value: item.description ?? '-' },
          {
            label: 'source',
            value: `${item.source}${item.source_ref ? ` (${item.source_ref})` : ''}`,
          },
          { label: 'labels', value: (item.labels ?? []).join(', ') || '-' },
          { label: 'version', value: String(item.version) },
          {
            label: 'lease',
            value: lease ? `${lease.holder_peer_id} → ${lease.expires_at ?? '-'}` : '-',
          },
        ],
      };
    }),
    sections:
      data.sessionLines.length > 0
        ? [{ title: i18n.tr('tui:tui_tab_tasks'), lines: data.sessionLines }]
        : undefined,
  };
}
