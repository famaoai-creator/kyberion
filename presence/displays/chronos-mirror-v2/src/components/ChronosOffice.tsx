'use client';

import * as React from 'react';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';
import {
  parseAgentActivityResponse,
  type ClientAgentActivity,
} from '../lib/agent-activity-response';

type Office = Pick<ClientAgentActivity, 'rooms' | 'attention'>;
type TrackRecord = ClientAgentActivity['trackRecords'][number];

export type OfficeAgent = Office['rooms'][number]['agents'][number];

export function dedupeOfficeAgents(agents: OfficeAgent[]): OfficeAgent[] {
  return Array.from(new Map(agents.map((agent) => [agent.agent_id, agent])).values());
}

const STATUS_LABEL_KEY: Record<string, string> = {
  backlog: 'chronos_status_backlog',
  ready: 'chronos_status_ready',
  in_progress: 'chronos_status_in_progress',
  blocked: 'chronos_blocked_count',
  review: 'chronos_status_review',
  done: 'chronos_status_done',
  archived: 'chronos_status_archived',
};

export function ChronosOffice({
  compact = false,
  tenant = '',
  onOpenOperations,
}: {
  compact?: boolean;
  tenant?: string;
  onOpenOperations?: () => void;
}) {
  const locale = useChronosLocale();
  const [office, setOffice] = React.useState<Office | null>(null);
  const [trackRecords, setTrackRecords] = React.useState<TrackRecord[]>([]);
  const [error, setError] = React.useState<string | null>(null);

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
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const statusLabel = (status: string): string =>
    uxText(STATUS_LABEL_KEY[status] || 'chronos_status_unknown', locale);

  return (
    <section
      className={`rounded-2xl border kb-border-accent kb-surface-accent p-4 ${compact ? '' : 'md:p-5'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-accent">
            {uxText('chronos_office', locale)}
          </div>
          <div className="mt-1 max-w-2xl text-[11px] kb-text-muted">
            {compact
              ? uxText('chronos_home_office_hint', locale)
              : uxText('chronos_office_description', locale)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border kb-border-subtle px-2 py-1 text-[10px] kb-text-secondary">
            {uxText('chronos_attention', locale)} {office?.attention.length || 0}
          </span>
        </div>
      </div>

      {error ? <div className="mt-3 text-[11px] kb-status-negative">{error}</div> : null}
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(office?.rooms || []).map((room) => (
          <div
            key={room.room_id}
            className="rounded-xl border kb-border-subtle kb-surface-sunken p-3"
          >
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary">
              {room.title}
            </div>
            <div className="mt-2 grid gap-2">
              {dedupeOfficeAgents(room.agents).map((agent) => (
                <div
                  key={`${room.room_id}:${agent.agent_id}`}
                  className="flex items-center gap-2 rounded-lg kb-surface-raised px-2 py-2 text-[11px]"
                >
                  <span
                    className={`h-2 w-2 rounded-full ${agent.pressure?.severity === 'saturated' || agent.status === 'blocked' ? 'kb-status-negative-surface' : agent.pressure?.severity === 'elevated' ? 'kb-status-warning-surface' : agent.status === 'in_progress' ? 'kb-surface-accent' : 'kb-surface-raised'}`}
                  />
                  <span className="font-semibold kb-text-primary">{agent.agent_id}</span>
                  <span className="ml-auto kb-text-muted">{statusLabel(agent.status)}</span>
                  {agent.pressure && agent.pressure.severity !== 'normal' ? (
                    <span className="rounded border kb-border-subtle px-1 text-[9px] kb-text-muted">
                      {agent.pressure.severity}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        {(office?.rooms || []).length === 0 ? (
          <div className="rounded-xl border kb-border-subtle kb-surface-sunken p-3 text-[11px] kb-text-muted">
            {uxText('chronos_no_active_agent_work', locale)}
          </div>
        ) : null}
      </div>

      {!compact ? (
        <div className="mt-4 border-t kb-border-subtle pt-4">
          <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-secondary">
            {uxText('chronos_track_record', locale)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {trackRecords.map((record) => (
              <div
                key={record.agent_id}
                className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2 text-[11px]"
              >
                <span className="font-bold kb-text-primary">{record.agent_id}</span>
                <span className="ml-2 kb-text-accent">{record.rank}</span>
                <span className="ml-2 kb-text-secondary">完了 {record.completed_tasks}</span>
                <span className="ml-2 kb-text-muted">
                  review {Math.round(record.review_pass_rate * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : onOpenOperations ? (
        <button
          type="button"
          onClick={onOpenOperations}
          className="mt-4 rounded-xl border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-accent"
        >
          {uxText('chronos_nav_operations', locale)} →
        </button>
      ) : null}
    </section>
  );
}
