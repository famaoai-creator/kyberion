'use client';

import * as React from 'react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  Section,
  Select,
  Skeleton,
  StatusPill,
  Table,
  TextField,
} from '@agent/shared-ui';
import { AgentCollaborationBoard } from './AgentCollaborationBoard';
import { ChronosFieldScope, ChronosInline, ChronosMeta, ChronosToolbar } from './chronos-ui';
import { ChronosOffice } from './ChronosOffice';
import { LiveTerminalDrawer } from './LiveTerminalDrawer';
import { useChronosLocale } from '../lib/hooks';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import { parseAgentActivityBoardResponse } from '../lib/agent-activity-response';

// AC-09: mirrors `@agent/core/agent-activity-board`'s `UNASSIGNED_AGENT_ID`.
// Re-declared, not imported: `agent-activity-board.ts` pulls in server-only
// modules (work-coordination, mission-state, …) that a client component
// bundle cannot resolve — the same reason `collaboration-response.ts`
// re-declares its core types instead of importing them.
const UNASSIGNED_AGENT_ID = 'unassigned';

type Blocker = { kind: string; reason: string };

// AC-09: `blocker.reason` on the wire is developer-facing English — the
// board renders from `kind` through this vocabulary instead.
const BLOCKER_LABEL_KEY: Record<string, string> = {
  blocked: 'chronos_blocker_blocked',
  dependency: 'chronos_blocker_dependency',
  review_wait: 'chronos_blocker_review_wait',
  unassigned: 'chronos_blocker_unassigned',
};

function blockerLabel(blocker: Blocker, locale: SupportedLocale): string {
  const key = BLOCKER_LABEL_KEY[blocker.kind];
  return key ? uxText(key, locale) : blocker.reason;
}

function agentIdLabel(agentId: string, locale: SupportedLocale): string {
  return agentId === UNASSIGNED_AGENT_ID ? uxText('chronos_agent_unassigned', locale) : agentId;
}
type Entry = {
  agent_id: string;
  team_role?: string;
  mission_id?: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  task_id?: string;
  work_shape?: string;
  item_id: string;
  title: string;
  status: string;
  phase?: string;
  blockers: Blocker[];
};
type Board = {
  generated_at: string;
  entries: Entry[];
  agents: Array<{ agent_id: string; active: number; blocked: number; in_review: number }>;
};

/** Work-item status → canonical `ui:status-pill` status. */
const STATUS_PILL: Record<string, KbStatus> = {
  backlog: 'planned',
  ready: 'ready',
  in_progress: 'working',
  review: 'review',
  done: 'done',
};

/** Tenant › organization › project › mission › task, with missing links marked. */
export function lineageLine(entry: Entry, locale: SupportedLocale): string {
  const missing = uxText('chronos_lineage_missing', locale);
  const parts = [
    `${uxText('chronos_tenant', locale)}: ${entry.tenant_slug || missing}`,
    `${uxText('chronos_lineage_organization', locale)}: ${entry.organization_id || missing}`,
    `${uxText('chronos_lineage_project', locale)}: ${entry.project_id || missing}`,
    `${uxText('chronos_lineage_mission', locale)}: ${entry.mission_id || missing}`,
    `${uxText('chronos_lineage_task', locale)}: ${entry.task_id || missing}`,
  ];
  if (entry.phase) parts.push(`${uxText('chronos_phase', locale)}: ${entry.phase}`);
  if (entry.work_shape) parts.push(`${uxText('chronos_work_shape', locale)}: ${entry.work_shape}`);
  return parts.join(' · ');
}

const STATUS_LABEL_KEY: Record<string, string> = {
  backlog: 'chronos_status_backlog',
  ready: 'chronos_status_ready',
  in_progress: 'chronos_status_in_progress',
  review: 'chronos_status_review',
  done: 'chronos_status_done',
};

/** どのエージェントが今何をしていて、どこがブロッカーか(V2)。 */
export function AgentOpsBoards({
  onOpenMission,
  onOpenView,
  tenant: scopedTenant = '',
}: {
  onOpenMission?: (missionId: string) => void;
  tenant?: string;
  onOpenView?: (
    viewId:
      | 'secret-approval-queue'
      | 'runtime-topology-map'
      | 'runtime-lease-doctor'
      | 'trace-viewer'
      | 'mission-control-plane'
  ) => void;
}) {
  const locale = useChronosLocale();
  const statusLabel = (status: string): string =>
    uxText(STATUS_LABEL_KEY[status] || 'chronos_status_unknown', locale);
  const [board, setBoard] = React.useState<Board | null>(null);
  const [tenant, setTenant] = React.useState('');
  const [terminal, setTerminal] = React.useState<{
    agentId: string;
    itemId: string;
    missionId?: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [activityQuery, setActivityQuery] = React.useState('');
  const [activityFilter, setActivityFilter] = React.useState<'all' | 'attention' | 'active'>('all');
  const [showAllActivity, setShowAllActivity] = React.useState(false);

  React.useEffect(() => {
    setTenant(scopedTenant);
  }, [scopedTenant]);

  const refresh = React.useCallback(async () => {
    try {
      const activityResponse = await fetch(
        `/api/agent-activity${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
        {
          cache: 'no-store',
        }
      );
      const activity = parseAgentActivityBoardResponse(
        await activityResponse.json().catch(() => null)
      );
      if (!activityResponse.ok || !activity) throw new Error('Invalid agent activity response');
      setBoard(activity.board);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const tenants = React.useMemo(
    () =>
      Array.from(
        new Set(
          (board?.entries || [])
            .map((entry) => entry.tenant_slug)
            .filter((slug): slug is string => Boolean(slug))
        )
      ),
    [board]
  );

  const activityEntries = React.useMemo(() => {
    const query = activityQuery.trim().toLowerCase();
    return [...(board?.entries || [])]
      .filter((entry) => {
        if (activityFilter === 'attention' && entry.blockers.length === 0) return false;
        if (activityFilter === 'active' && entry.status !== 'in_progress') return false;
        if (!query) return true;
        return [
          entry.agent_id,
          entry.team_role,
          entry.title,
          entry.tenant_slug,
          entry.organization_id,
          entry.project_id,
          entry.mission_id,
          entry.task_id,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .sort((left, right) => Number(right.blockers.length > 0) - Number(left.blockers.length > 0));
  }, [activityFilter, activityQuery, board]);

  const visibleActivityEntries = showAllActivity ? activityEntries : activityEntries.slice(0, 6);
  const attentionCount = (board?.entries || []).filter((entry) => entry.blockers.length > 0).length;

  const onFieldChange = (name: string, value: unknown) => {
    const text = typeof value === 'string' ? value : '';
    if (name === 'activity_query') {
      setActivityQuery(text);
      setShowAllActivity(false);
    } else if (name === 'activity_filter') {
      if (text === 'all' || text === 'attention' || text === 'active') setActivityFilter(text);
      setShowAllActivity(false);
    } else if (name === 'activity_tenant') {
      setTenant(text);
    }
  };

  return (
    <div className="chronos-stack">
      <Section
        title={uxText('chronos_activity_summary_title', locale)}
        description={uxText('chronos_activity_summary_detail', locale)}
      >
        <ChronosFieldScope onChange={onFieldChange}>
          <ChronosToolbar>
            <TextField
              name="activity_query"
              type="search"
              label={uxText('chronos_activity_search_label', locale)}
              hide_label
              value={activityQuery}
              placeholder={uxText('chronos_activity_search_placeholder', locale)}
            />
            <Select
              name="activity_filter"
              label={uxText('chronos_activity_filter_label', locale)}
              hide_label
              value={activityFilter}
              options={[
                { value: 'all', label: uxText('chronos_activity_filter_all', locale) },
                { value: 'attention', label: uxText('chronos_activity_filter_attention', locale) },
                { value: 'active', label: uxText('chronos_activity_filter_active', locale) },
              ]}
            />
            {!scopedTenant ? (
              <Select
                name="activity_tenant"
                label={uxText('chronos_tenant', locale)}
                hide_label
                value={tenant}
                options={[
                  { value: '', label: uxText('chronos_all_tenants', locale) },
                  ...tenants.map((slug) => ({ value: slug, label: slug })),
                ]}
              />
            ) : null}
            <div className="chronos-toolbar__end">
              <ChronosInline>
                <Badge
                  tone={attentionCount > 0 ? 'warning' : 'neutral'}
                  label={`${uxText('chronos_attention', locale)} ${attentionCount}`}
                />
                <Badge
                  label={`${uxText('chronos_activity_visible_count', locale)} ${activityEntries.length}`}
                />
              </ChronosInline>
            </div>
          </ChronosToolbar>
        </ChronosFieldScope>

        {error ? <Callout tone="danger" title={error} /> : null}

        {!board && !error ? (
          <Skeleton shape="table" lines={4} />
        ) : (
          <Table
            columns={[
              { key: 'work', label: uxText('chronos_ops_col_work', locale) },
              { key: 'agent', label: uxText('chronos_col_agent', locale), width: '14rem' },
              { key: 'status', label: uxText('chronos_col_status', locale), width: '8rem' },
              { key: 'blockers', label: uxText('chronos_ops_col_blockers', locale) },
              { key: 'actions', label: uxText('chronos_ops_col_actions', locale), align: 'end' },
            ]}
            row_key="id"
            empty={uxText('chronos_activity_no_matches', locale)}
            rows={visibleActivityEntries.map((entry) => ({
              id: entry.item_id,
              work: (
                <span className="chronos-work-cell">
                  <span className="chronos-work-cell__title">{entry.title}</span>
                  <ChronosMeta mono>{lineageLine(entry, locale)}</ChronosMeta>
                </span>
              ),
              agent: (
                <span className="chronos-work-cell">
                  <span>{agentIdLabel(entry.agent_id, locale)}</span>
                  {entry.team_role ? <ChronosMeta>{entry.team_role}</ChronosMeta> : null}
                </span>
              ),
              status: (
                <StatusPill
                  status={STATUS_PILL[entry.status] || 'n/a'}
                  label={statusLabel(entry.status)}
                />
              ),
              blockers:
                entry.blockers.length > 0 ? (
                  <ChronosInline>
                    {entry.blockers.map((blocker, index) => (
                      <Badge
                        key={index}
                        tone={blocker.kind === 'review_wait' ? 'neutral' : 'warning'}
                        label={blockerLabel(blocker, locale)}
                      />
                    ))}
                  </ChronosInline>
                ) : (
                  '-'
                ),
              actions:
                entry.agent_id !== UNASSIGNED_AGENT_ID ? (
                  <Button
                    label={uxText('chronos_live_terminal', locale)}
                    variant="ghost"
                    onClick={() =>
                      setTerminal({
                        agentId: entry.agent_id,
                        itemId: entry.item_id,
                        missionId: entry.mission_id,
                      })
                    }
                  />
                ) : (
                  ''
                ),
            }))}
          />
        )}
        {activityEntries.length > 6 ? (
          <ChronosInline>
            <Button
              variant="ghost"
              label={uxText(
                showAllActivity ? 'chronos_activity_show_less' : 'chronos_activity_show_all',
                locale
              )}
              onClick={() => setShowAllActivity((current) => !current)}
            />
          </ChronosInline>
        ) : null}
      </Section>

      {terminal ? (
        <LiveTerminalDrawer
          agentId={terminal.agentId}
          itemId={terminal.itemId}
          missionId={terminal.missionId}
          onClose={() => setTerminal(null)}
        />
      ) : null}

      <Section
        title={uxText('chronos_agent_activity', locale)}
        description={uxText('chronos_ops_agents_description', locale)}
      >
        {(board?.agents || []).length === 0 ? (
          <p className="kb-text kb-text--muted">{uxText('chronos_no_active_agent_work', locale)}</p>
        ) : (
          <Table
            columns={[
              { key: 'agent', label: uxText('chronos_col_agent', locale) },
              { key: 'active', label: uxText('chronos_ops_col_active', locale), align: 'end' },
              { key: 'blocked', label: uxText('chronos_blocked_count', locale), align: 'end' },
              { key: 'in_review', label: uxText('chronos_review_waiting', locale), align: 'end' },
            ]}
            row_key="agent"
            rows={(board?.agents || []).map((agent) => ({
              agent: agentIdLabel(agent.agent_id, locale),
              active: agent.active,
              blocked: agent.blocked,
              in_review: agent.in_review,
            }))}
          />
        )}
      </Section>

      <AgentCollaborationBoard
        tenant={tenant}
        onOpenMission={onOpenMission}
        onOpenView={onOpenView}
      />
      <ChronosOffice tenant={tenant} onOpenMission={onOpenMission} />
    </div>
  );
}
