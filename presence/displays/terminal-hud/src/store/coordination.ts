import {
  discoverProviders,
  listDemotedProviders,
  listAgentRuntimesViaDaemon,
  listDaemonHeartbeatStatuses,
  listSurfaceOutboxMessages,
  listSurfaceDeadLetters,
  buildAgentCollaborationProjection,
  pathResolver,
  type AgentRuntimeSupervisorSnapshot,
} from '@agent/core';
import { statusColor, theme } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { PanelViewModel } from './types.js';

const OUTBOX_SURFACES = ['slack', 'telegram', 'discord', 'imessage'];

export interface CoordinationData {
  runtimes: AgentRuntimeSupervisorSnapshot[] | null; // null = supervisor daemon offline
  providerLines: string[];
  outboxLines: string[];
  attentionLines: string[];
}

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
      const pending = listSurfaceOutboxMessages(surface, { includeTenantNamespaces: true }).length;
      const dead = listSurfaceDeadLetters(surface).length;
      if (pending > 0 || dead > 0) {
        outboxLines.push(`${surface}: ${pending} pending, ${dead} dead`);
      }
    } catch {
      // missing per-surface store dirs are normal
    }
  }

  let attentionLines: string[] = [];
  try {
    const projection: any = buildAgentCollaborationProjection();
    const attention = projection?.attention ?? projection?.attention_items ?? [];
    attentionLines = (Array.isArray(attention) ? attention : [])
      .slice(0, 5)
      .map((item: any) =>
        typeof item === 'string'
          ? item
          : String(item.summary ?? item.reason ?? JSON.stringify(item))
      );
    const overview = projection?.overview;
    if (overview) {
      attentionLines.unshift(
        `events ${overview.events} / missions ${overview.missions} / agents ${overview.agents} / active ${overview.active}`
      );
    }
  } catch {
    // collaboration projection is optional context
  }

  return { runtimes, providerLines, outboxLines, attentionLines };
}

export function coordinationWatchPaths(): string[] {
  return [
    pathResolver.active('shared/runtime/presence'),
    pathResolver.active('shared/runtime/provider-health.json'),
  ];
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
  if (data.attentionLines.length > 0) {
    sections.push({ title: i18n.tr('tui:tui_coord_attention'), lines: data.attentionLines });
  }
  return {
    columns: [
      i18n.tr('tui:tui_coord_runtimes'),
      'provider',
      i18n.tr('tui:tui_mission_col_status'),
      'pid',
    ],
    rows: (data.runtimes ?? []).map((runtime) => ({
      id: runtime.agent_id,
      color: statusColor(runtime.status ?? undefined) || theme.dim,
      cells: [
        runtime.agent_id,
        `${runtime.provider ?? '-'}${runtime.model_id ? `/${runtime.model_id}` : ''}`,
        runtime.status ?? '-',
        runtime.pid !== undefined ? String(runtime.pid) : '-',
      ],
    })),
    sections,
  };
}
