import { discoverProviders } from '@agent/core/provider-discovery';
import { listDemotedProviders } from '@agent/core/provider-health-view';
import { listAgentRuntimesViaDaemon } from '@agent/core/agent-runtime-supervisor-client';
import { listDaemonHeartbeatStatuses } from '@agent/core/daemon-heartbeat';
import {
  listSurfaceOutboxMessages,
  listSurfaceDeadLetters,
} from '@agent/core/surface-coordination-store';
import {
  buildAgentCollaborationProjection,
  type CollaborationAttentionCode,
  type CollaborationAttentionItem,
} from '@agent/core/agent-collaboration-projection';
import { currentScope } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import type { AgentRuntimeSupervisorSnapshot } from '@agent/core/agent-runtime-supervisor-client';
import type { SurfaceAsyncChannel } from '@agent/core/channel-surface-types';
import type { VocabularyKey } from '@agent/core/t';
import { statusColor, theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { DetailLine, PanelViewModel } from './types.js';

const OUTBOX_SURFACES: readonly SurfaceAsyncChannel[] = [
  'slack',
  'telegram',
  'discord',
  'imessage',
];

export interface CoordinationData {
  runtimes: AgentRuntimeSupervisorSnapshot[] | null; // null = supervisor daemon offline
  providerLines: string[];
  outboxLines: string[];
  /** AC-09: the projection's own attention items, not pre-formatted text —
   * `coordinationViewModel` translates `code` through the vocabulary. */
  attention: CollaborationAttentionItem[];
  overviewLine?: string;
}

const ATTENTION_LABEL_KEYS: Record<CollaborationAttentionCode, VocabularyKey> = {
  blocked: 'tui:tui_attention_blocked',
  waiting_human: 'tui:tui_attention_waiting_human',
  review_pending: 'tui:tui_attention_review_pending',
  failure: 'tui:tui_attention_failure',
};

const ATTENTION_NEXT_KEYS: Record<CollaborationAttentionCode, VocabularyKey> = {
  blocked: 'tui:tui_attention_next_blocked',
  waiting_human: 'tui:tui_attention_next_waiting_human',
  review_pending: 'tui:tui_attention_next_review_pending',
  failure: 'tui:tui_attention_next_failure',
};

const SUPERVISOR_DAEMON_ID = 'agent-runtime-supervisor-daemon';

function supervisorDaemonHealthy(): boolean {
  try {
    return listDaemonHeartbeatStatuses().some(
      (hb) => hb.daemon_id === SUPERVISOR_DAEMON_ID && hb.status === 'healthy'
    );
  } catch {
    return false;
  }
}

export async function loadCoordination(): Promise<CoordinationData> {
  const scope = currentScope();
  // The IPC client auto-spawns the supervisor daemon on every call; an
  // observability panel must not have that side effect, so only talk to the
  // daemon when its heartbeat already reports healthy.
  let runtimes: AgentRuntimeSupervisorSnapshot[] | null = null;
  if (supervisorDaemonHealthy()) {
    try {
      runtimes = await listAgentRuntimesViaDaemon();
    } catch {
      runtimes = null;
    }
  }

  let providerLines: string[] = [];
  try {
    const demoted = new Set(listDemotedProviders().map((d: any) => String(d.provider ?? d)));
    providerLines = discoverProviders()
      .filter((provider) => provider.installed)
      .map((provider) => {
        const flags = [
          provider.healthy ? '●' : '○',
          demoted.has(provider.provider) ? '↓' : '',
        ].join('');
        return `${flags} ${provider.provider} ${provider.version ?? ''} (${provider.protocol})`;
      });
  } catch {
    // provider discovery cache may be unavailable
  }

  const outboxLines: string[] = [];
  for (const surface of OUTBOX_SURFACES) {
    try {
      const pending = listSurfaceOutboxMessages(surface, { scope }).length;
      const dead = listSurfaceDeadLetters(surface, { scope }).length;
      if (pending > 0 || dead > 0) {
        outboxLines.push(`${surface}: ${pending} pending, ${dead} dead`);
      }
    } catch {
      // missing per-surface store dirs are normal
    }
  }

  let attention: CollaborationAttentionItem[] = [];
  let overviewLine: string | undefined;
  try {
    const projection = buildAgentCollaborationProjection();
    attention = projection.attention.slice(0, 5);
    const overview = projection.overview;
    overviewLine = `events ${overview.events} / missions ${overview.missions} / agents ${overview.agents} / active ${overview.active}`;
  } catch {
    // collaboration projection is optional context
  }

  return { runtimes, providerLines, outboxLines, attention, overviewLine };
}

export function coordinationWatchPaths(): string[] {
  return [
    pathResolver.active('shared/runtime/presence'),
    pathResolver.active('shared/runtime/provider-health.json'),
  ];
}

/** `<label> · <reason>` with a `(mission=… agent=…)` suffix when present. */
function formatAttentionLine(item: CollaborationAttentionItem, i18n: I18n): string {
  const label = i18n.tr(ATTENTION_LABEL_KEYS[item.code]);
  const ids = [
    item.mission_id ? `mission=${item.mission_id}` : undefined,
    item.agent_id ? `agent=${item.agent_id}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const suffix = ids.length > 0 ? ` (${ids.join(' ')})` : '';
  return `${label} · ${item.reason}${suffix}`;
}

/** Row detail for the attention items attributed to one runtime's agent id. */
function attentionDetailLines(
  attention: CollaborationAttentionItem[],
  agentId: string,
  i18n: I18n
): DetailLine[] {
  return attention
    .filter((item) => item.agent_id === agentId)
    .map((item) => ({
      label: i18n.tr('tui:tui_coord_attention'),
      value: `${formatAttentionLine(item, i18n)} — ${i18n.tr('tui:tui_cockpit_next_action')}: ${i18n.tr(ATTENTION_NEXT_KEYS[item.code])}`,
    }));
}

export function coordinationViewModel(data: CoordinationData, i18n: I18n): PanelViewModel {
  const sections = [];
  if (data.runtimes === null) {
    sections.push({ lines: [i18n.tr('tui:tui_coord_daemon_offline')] });
  }
  if (data.providerLines.length > 0) {
    sections.push({ title: i18n.tr('tui:tui_coord_providers'), lines: data.providerLines });
  }
  if (data.outboxLines.length > 0) {
    sections.push({ title: i18n.tr('tui:tui_coord_outbox'), lines: data.outboxLines });
  }
  const attentionLines = [
    ...(data.overviewLine ? [data.overviewLine] : []),
    ...data.attention.map((item) => formatAttentionLine(item, i18n)),
  ];
  if (attentionLines.length > 0) {
    sections.push({ title: i18n.tr('tui:tui_coord_attention'), lines: attentionLines });
  }
  return {
    columns: [
      i18n.tr('tui:tui_coord_runtimes'),
      'provider',
      i18n.tr('tui:tui_mission_col_status'),
      'pid',
    ],
    rows: (data.runtimes ?? []).map((runtime) => {
      const detail = attentionDetailLines(data.attention, runtime.agent_id, i18n);
      return {
        id: runtime.agent_id,
        color: statusColor(runtime.status ?? undefined) || theme.dim,
        cells: [
          runtime.agent_id,
          `${runtime.provider ?? '-'}${runtime.model_id ? `/${runtime.model_id}` : ''}`,
          runtime.status ?? '-',
          runtime.pid !== undefined ? String(runtime.pid) : '-',
        ],
        ...(detail.length > 0 ? { detail } : {}),
      };
    }),
    sections,
  };
}
