'use client';

import * as React from 'react';
import { AgentCollaborationBoard } from './AgentCollaborationBoard';
import { ChronosOffice } from './ChronosOffice';
import { LiveTerminalDrawer } from './LiveTerminalDrawer';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

type Blocker = { kind: string; reason: string };
type Entry = {
  agent_id: string;
  team_role?: string;
  mission_id?: string;
  tenant_slug?: string;
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
}: {
  onOpenMission?: (missionId: string) => void;
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

  const refresh = React.useCallback(async () => {
    try {
      const activityResponse = await fetch(
        `/api/agent-activity${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
        {
          cache: 'no-store',
        }
      );
      const activity = await activityResponse.json();
      if (activity.ok) setBoard(activity.board);
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
      Array.from(new Set((board?.entries || []).map((entry) => entry.tenant_slug).filter(Boolean))),
    [board]
  );

  return (
    <div className="flex flex-col gap-6">
      <AgentCollaborationBoard
        tenant={tenant}
        onOpenMission={onOpenMission}
        onOpenView={onOpenView}
      />
      <ChronosOffice tenant={tenant} />
      {terminal ? (
        <LiveTerminalDrawer
          agentId={terminal.agentId}
          itemId={terminal.itemId}
          missionId={terminal.missionId}
          onClose={() => setTerminal(null)}
        />
      ) : null}
      <div className="flex items-center gap-3">
        <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-secondary">
          {uxText('chronos_agent_activity', locale)}
        </div>
        <select
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
          className="rounded border kb-border-subtle kb-surface-well px-2 py-1 text-[11px] kb-text-primary"
        >
          <option value="">{uxText('chronos_all_tenants', locale)}</option>
          {tenants.map((slug) => (
            <option key={slug} value={slug as string}>
              {slug}
            </option>
          ))}
        </select>
        {error ? <span className="text-[11px] kb-status-negative">{error}</span> : null}
      </div>

      {/* エージェント別サマリ */}
      <div className="flex flex-wrap gap-2">
        {(board?.agents || []).map((agent) => (
          <div
            key={agent.agent_id}
            className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2 text-[11px]"
          >
            <span className="font-bold kb-text-primary">{agent.agent_id}</span>
            <span className="ml-2 kb-text-accent">稼働 {agent.active}</span>
            <span className="ml-2 kb-status-warning">
              {uxText('chronos_blocked_count', locale)} {agent.blocked}
            </span>
            <span className="ml-2 kb-text-muted">
              {uxText('chronos_review_waiting', locale)} {agent.in_review}
            </span>
          </div>
        ))}
        {(board?.agents || []).length === 0 ? (
          <div className="text-[11px] kb-text-muted">
            {uxText('chronos_no_active_agent_work', locale)}
          </div>
        ) : null}
      </div>

      {/* 現在のタスクとブロッカー */}
      <div className="grid gap-2">
        {(board?.entries || []).map((entry) => (
          <div
            key={entry.item_id}
            className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold kb-text-primary">{entry.agent_id}</span>
              {entry.team_role ? (
                <span className="rounded-full border kb-border-subtle px-2 text-[10px] kb-text-muted">
                  {entry.team_role}
                </span>
              ) : null}
              <span className="kb-text-secondary">{entry.title}</span>
              <span className="ml-auto rounded-full border kb-border-accent px-2 text-[10px] kb-text-accent">
                {statusLabel(entry.status)}
              </span>
            </div>
            <div className="mt-1 text-[10px] kb-text-muted">
              {entry.mission_id}
              {entry.phase ? ` · phase: ${entry.phase}` : ''}
              {entry.tenant_slug ? ` · tenant: ${entry.tenant_slug}` : ''}
            </div>
            {entry.blockers.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {entry.blockers.map((blocker, index) => (
                  <span
                    key={index}
                    className={`rounded-lg px-2 py-1 text-[10px] ${
                      blocker.kind === 'review_wait'
                        ? 'kb-surface-raised kb-text-secondary'
                        : 'kb-status-warning-surface kb-status-warning'
                    }`}
                  >
                    🚧 {blocker.reason}
                  </span>
                ))}
              </div>
            ) : null}
            {entry.agent_id !== '(未割当)' ? (
              <button
                type="button"
                onClick={() =>
                  setTerminal({
                    agentId: entry.agent_id,
                    itemId: entry.item_id,
                    missionId: entry.mission_id,
                  })
                }
                className="mt-2 rounded border kb-border-subtle px-2 py-1 text-[10px] kb-text-accent"
              >
                {uxText('chronos_live_terminal', locale)}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
