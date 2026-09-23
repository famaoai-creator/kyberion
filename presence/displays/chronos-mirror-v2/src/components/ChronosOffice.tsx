'use client';

import * as React from 'react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { Callout, Section, Skeleton, StatusPill } from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText } from '../lib/ux-vocabulary';
import {
  parseAgentActivityResponse,
  type ClientAgentActivity,
} from '../lib/agent-activity-response';

type Office = Pick<ClientAgentActivity, 'rooms' | 'attention'>;
type TrackRecord = ClientAgentActivity['trackRecords'][number];

export type OfficeAgent = Office['rooms'][number]['agents'][number];
export type OfficeRoom = Office['rooms'][number];

export function dedupeOfficeAgents(agents: OfficeAgent[]): OfficeAgent[] {
  return Array.from(new Map(agents.map((agent) => [agent.agent_id, agent])).values());
}

/** Agent states that need a human look (mirrors composeOfficeSnapshot's attention rule). */
const ATTENTION_STATUSES = new Set(['blocked', 'review', 'waiting', 'offline']);

export function agentNeedsAttention(agent: OfficeAgent): boolean {
  return (
    ATTENTION_STATUSES.has(agent.status) ||
    Boolean(agent.pressure && agent.pressure.severity !== 'normal')
  );
}

/** Work-item agent status → canonical `ui:status-pill` status, most urgent first. */
const ROOM_STATUS_ORDER: Array<[string, KbStatus]> = [
  ['blocked', 'blocked'],
  ['offline', 'offline'],
  ['review', 'review'],
  ['waiting', 'pending'],
  ['in_progress', 'working'],
  ['ready', 'ready'],
  ['backlog', 'planned'],
  ['done', 'done'],
  ['archived', 'archived'],
];

export function roomStatus(agents: OfficeAgent[]): KbStatus {
  const statuses = new Set(agents.map((agent) => agent.status));
  for (const [agentStatus, pillStatus] of ROOM_STATUS_ORDER) {
    if (statuses.has(agentStatus)) return pillStatus;
  }
  return 'n/a';
}

const OPERATOR_FLOOR_ROOM_ID = 'operator-floor';

/**
 * Fallback human title for a mission id when no goal summary is known:
 * `MSN-BACKEND-CAPABILITY-CONSOLIDATION-20260822A` → "Backend capability
 * consolidation". The id itself is always shown next to it in mono.
 */
export function humanizeMissionId(missionId: string): string {
  const words = missionId
    .replace(/^MSN-/i, '')
    .replace(/-\d{6,8}[A-Z]?$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return missionId;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface MissionRow {
  missionId: string;
  title: string;
  agents: OfficeAgent[];
  status: KbStatus;
  attention: number;
  isOperatorFloor: boolean;
}

/** One row per mission room, most attention first. */
export function buildMissionRows(
  rooms: OfficeRoom[],
  missionTitles: Readonly<Record<string, string | undefined>> = {},
  operatorFloorTitle = 'Operator floor'
): MissionRow[] {
  return rooms
    .map((room) => {
      const agents = dedupeOfficeAgents(room.agents);
      const isOperatorFloor = room.room_id === OPERATOR_FLOOR_ROOM_ID;
      return {
        missionId: room.room_id,
        title: isOperatorFloor
          ? operatorFloorTitle
          : missionTitles[room.room_id]?.trim() || humanizeMissionId(room.room_id),
        agents,
        status: roomStatus(agents),
        attention: agents.filter(agentNeedsAttention).length,
        isOperatorFloor,
      };
    })
    .sort(
      (left, right) =>
        right.attention - left.attention ||
        Number(right.status === 'blocked') - Number(left.status === 'blocked') ||
        left.title.localeCompare(right.title)
    );
}

export interface ChronosOfficeState {
  office: Office | null;
  trackRecords: TrackRecord[];
  error: string | null;
  loading: boolean;
}

/** Agent activity (rooms = missions) for the viewer's tenant scope, refreshed every 30s. */
export function useChronosOffice(tenant = ''): ChronosOfficeState {
  const [office, setOffice] = React.useState<Office | null>(null);
  const [trackRecords, setTrackRecords] = React.useState<TrackRecord[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(
        `/api/agent-activity${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
        {
          cache: 'no-store',
        }
      );
      const payload = parseAgentActivityResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid agent activity response');
      setOffice({ rooms: payload.rooms, attention: payload.attention });
      setTrackRecords(payload.trackRecords);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { office, trackRecords, error, loading };
}

const AGENT_PREVIEW_LIMIT = 3;

/**
 * UI-07: missions in motion as one compact table (human title with the
 * mission id as a mono secondary line, assignees, status pill, attention
 * count), sorted by attention — replacing the wall of identical
 * mission → agent cards.
 */
export function ChronosMissionTable({
  rows,
  onOpenMission,
}: {
  rows: MissionRow[];
  onOpenMission?: (missionId: string) => void;
}) {
  const locale = useChronosLocale();
  if (rows.length === 0) {
    return (
      <div className="kb-table-wrap">
        <table className="kb-table">
          <tbody>
            <tr>
              <td className="kb-table__empty">{uxText('chronos_no_active_agent_work', locale)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="kb-table-wrap">
      <table className="kb-table">
        <thead>
          <tr>
            <th scope="col">{uxText('chronos_col_mission', locale)}</th>
            <th scope="col">{uxText('chronos_col_assignees', locale)}</th>
            <th scope="col" style={{ width: '9rem' }}>
              {uxText('chronos_col_status', locale)}
            </th>
            <th scope="col" data-align="end" style={{ width: '7rem' }}>
              {uxText('chronos_col_attention', locale)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shown = row.agents.slice(0, AGENT_PREVIEW_LIMIT);
            const hidden = row.agents.length - shown.length;
            const canOpen = Boolean(onOpenMission) && !row.isOperatorFloor;
            return (
              <tr key={row.missionId}>
                <td>
                  <div className="chronos-mission-cell">
                    {canOpen ? (
                      <button
                        type="button"
                        className="chronos-mission-cell__title"
                        onClick={() => onOpenMission?.(row.missionId)}
                      >
                        {row.title}
                      </button>
                    ) : (
                      <span className="chronos-mission-cell__title">{row.title}</span>
                    )}
                    {row.isOperatorFloor ? null : (
                      <span className="chronos-mission-cell__id">{row.missionId}</span>
                    )}
                  </div>
                </td>
                <td className="chronos-muted">
                  {shown.map((agent) => agent.agent_id).join(', ')}
                  {hidden > 0
                    ? ` ${uxMessage('chronos_more_count', { count: hidden }, '+{count}', locale)}`
                    : ''}
                </td>
                <td>
                  <StatusPill status={row.status} />
                </td>
                <td data-align="end">
                  <span
                    className="chronos-attention-count"
                    data-zero={row.attention === 0 ? 'true' : undefined}
                  >
                    {row.attention}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Operations view of the office: the mission table plus each agent's track
 * record. The home view renders the table itself (see ChronosHome).
 */
export function ChronosOffice({
  tenant = '',
  missionTitles,
  onOpenMission,
}: {
  tenant?: string;
  missionTitles?: Readonly<Record<string, string | undefined>>;
  onOpenMission?: (missionId: string) => void;
}) {
  const locale = useChronosLocale();
  const { office, trackRecords, error, loading } = useChronosOffice(tenant);
  const rows = React.useMemo(
    () =>
      buildMissionRows(
        office?.rooms || [],
        missionTitles,
        uxText('chronos_office_operator_floor', locale)
      ),
    [office, missionTitles, locale]
  );

  return (
    <Section
      title={uxText('chronos_home_missions_title', locale)}
      description={uxText('chronos_home_missions_description', locale)}
    >
      {error ? <Callout tone="danger" title={error} /> : null}
      {loading && !office ? (
        <Skeleton shape="table" lines={4} />
      ) : (
        <ChronosMissionTable rows={rows} onOpenMission={onOpenMission} />
      )}
      {trackRecords.length > 0 ? (
        <div className="chronos-feed">
          <h3 className="chronos-feed__title">{uxText('chronos_track_record', locale)}</h3>
          <div className="kb-table-wrap">
            <table className="kb-table">
              <thead>
                <tr>
                  <th scope="col">{uxText('chronos_col_agent', locale)}</th>
                  <th scope="col">{uxText('chronos_col_rank', locale)}</th>
                  <th scope="col" data-align="end">
                    {uxText('chronos_col_completed', locale)}
                  </th>
                  <th scope="col" data-align="end">
                    {uxText('chronos_col_review_pass', locale)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {trackRecords.map((record) => (
                  <tr key={record.agent_id}>
                    <td data-mono="true">{record.agent_id}</td>
                    <td>{record.rank}</td>
                    <td data-align="end">{record.completed_tasks}</td>
                    <td data-align="end">{Math.round(record.review_pass_rate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
