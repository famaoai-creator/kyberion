import {
  listMissionSummaries,
  buildMissionStatusView,
  type MissionSummary,
} from '@agent/core/mission-read-model';
import { currentScope, type ScopeContext } from '@agent/core/scope-context';
import { pathResolver } from '@agent/core/path-resolver';
import { statusColor } from '../theme.js';
import type { I18n } from '../i18n.js';
import type { DetailLine, PanelViewModel } from './types.js';

export interface MissionsData {
  missions: MissionSummary[];
}

export function missionSummaryScope(scope: ScopeContext) {
  return {
    tier: scope.tier,
    tenantSlug: scope.tenant_slug || (scope.tier === 'public' ? undefined : null),
    organizationId: scope.organization_id,
    projectId: scope.project_id,
  } as const;
}

export function loadMissions(): MissionsData {
  const scope = currentScope();
  return { missions: listMissionSummaries(undefined, missionSummaryScope(scope)) };
}

export function missionsWatchPaths(): string[] {
  return [
    pathResolver.active('missions'),
    pathResolver.active('shared/runtime/mission_queue.jsonl'),
  ];
}

export function missionDetail(id: string, i18n: I18n): DetailLine[] {
  try {
    const view = buildMissionStatusView(id);
    if (!view) return [];
    const lines: DetailLine[] = [
      { label: i18n.tr('tui:tui_mission_next_action'), value: view.nextAction },
      { label: 'path', value: view.missionPath ?? '-' },
      { label: 'type', value: String(view.state.mission_type ?? '-') },
      { label: 'goal', value: String(view.state.intent?.goal_summary ?? '-') },
    ];
    for (const event of (view.recentHistory ?? []).slice(-5)) {
      lines.push({ label: String(event.ts ?? ''), value: String(event.event ?? '') });
    }
    return lines;
  } catch (err: unknown) {
    return [{ label: 'error', value: err instanceof Error ? err.message : String(err) }];
  }
}

export function missionsViewModel(data: MissionsData, i18n: I18n): PanelViewModel {
  return {
    columns: [
      'ID',
      i18n.tr('tui:tui_mission_col_status'),
      i18n.tr('tui:tui_mission_col_tier'),
      'persona',
      'ckpt',
      i18n.tr('tui:tui_detail_title'),
    ],
    rows: data.missions.map((mission) => ({
      id: mission.id,
      color: statusColor(mission.status),
      cells: [
        mission.id,
        mission.status,
        mission.tier,
        mission.persona,
        String(mission.checkpoints),
        mission.lastEvent,
      ],
    })),
  };
}
