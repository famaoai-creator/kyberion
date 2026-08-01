'use client';

import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Brain,
  CircleUserRound,
  GitBranch,
} from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

type WorkItem = {
  item_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  source: string;
  source_ref: string;
  project_id: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels: string[];
  dependencies: string[];
  created_at: string;
  updated_at: string;
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
  metadata?: Record<string, unknown>;
};

type WorkCoordinationSummary = {
  total: number;
  backlog: number;
  ready: number;
  inProgress: number;
  blocked: number;
  review: number;
  done: number;
  archived: number;
  runningAttempts: number;
};

const STATUS_LABEL_KEY: Record<string, string> = {
  backlog: 'chronos_status_backlog',
  ready: 'chronos_status_ready',
  in_progress: 'chronos_status_in_progress',
  blocked: 'chronos_blocked_count',
  review: 'chronos_status_review',
  done: 'chronos_status_done',
  archived: 'chronos_status_archived',
};

function metadataText(
  metadata: Record<string, unknown> | undefined,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function missionIdFromItem(item: WorkItem): string | null {
  const label = item.labels.find((entry) => entry.startsWith('mission:'));
  return label ? label.slice('mission:'.length) : item.project_id || null;
}

function compactDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function WorkItemsWorkspace({
  onOpenMission,
}: {
  onOpenMission?: (missionId: string) => void;
}) {
  const locale = useChronosLocale();
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [coordination, setCoordination] = React.useState<WorkCoordinationSummary | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [response, intelligenceResponse] = await Promise.all([
        fetch('/api/workitems', { cache: 'no-store' }),
        fetch('/api/intelligence', { cache: 'no-store' }),
      ]);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'work items failed');
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setStatuses(Array.isArray(payload.statuses) ? payload.statuses : []);
      if (intelligenceResponse.ok) {
        const intelligencePayload = await intelligenceResponse.json();
        setCoordination(intelligencePayload.workCoordination || null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const moveItem = React.useCallback(
    async (itemId: string, status: string) => {
      setBusyId(itemId);
      try {
        const response = await fetch('/api/workitems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId, status }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'move failed');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  const statusLabel = (status: string) =>
    uxText(STATUS_LABEL_KEY[status] || 'chronos_status_unknown', locale);

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_nav_work_items', locale)}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight kb-text-primary">
            {uxText('chronos_work_items', locale)}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 kb-text-secondary">
            {uxText('chronos_nav_work_items_hint', locale)}
          </p>
        </div>
        <div className="rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
          {items.length}
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}

      {coordination ? (
        <section className="mt-5 rounded-2xl border kb-border-accent kb-surface-accent p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.24em] kb-text-accent">
                {uxText('chronos_work_coordination', locale)}
              </div>
              <p className="mt-1 max-w-2xl text-[11px] leading-5 kb-text-muted">
                {uxText('chronos_work_coordination_description', locale)}
              </p>
            </div>
            <div className="rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary">
              {coordination.total}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <CoordinationMetric
              icon={<GitBranch size={13} />}
              label={uxText('chronos_work_items', locale)}
              value={coordination.total}
              detail={uxText('chronos_work_coordination_total_detail', locale)}
            />
            <CoordinationMetric
              icon={<Activity size={13} />}
              label={uxText('chronos_status_in_progress', locale)}
              value={coordination.inProgress}
              detail={uxText('chronos_work_coordination_in_progress_detail', locale)}
            />
            <CoordinationMetric
              icon={<AlertTriangle size={13} />}
              label={uxText('chronos_blocked_count', locale)}
              value={coordination.blocked}
              detail={uxText('chronos_work_coordination_blocked_detail', locale)}
            />
            <CoordinationMetric
              icon={<Brain size={13} />}
              label={uxText('chronos_work_coordination_running_attempts', locale)}
              value={coordination.runningAttempts}
              detail={uxText('chronos_work_coordination_running_attempts_detail', locale)}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[10px] kb-text-muted">
            {statuses.map((status) => (
              <span
                key={status}
                className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1"
              >
                {statusLabel(status)} {coordinationCount(coordination, status)}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {items.length === 0 ? (
        <div className="mt-5 rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-5 text-[11px] kb-text-muted">
          {uxText('chronos_work_item_no_items', locale)}
        </div>
      ) : (
        <div className="mt-5 grid gap-3 xl:grid-cols-6">
          {statuses.map((column) => {
            const columnItems = items.filter((item) => item.status === column);
            return (
              <div
                key={column}
                className="rounded-2xl border kb-border-subtle kb-surface-sunken p-2"
              >
                <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
                  <span>{statusLabel(column)}</span>
                  <span>{columnItems.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {columnItems.map((item) => {
                    const columnIndex = statuses.indexOf(column);
                    const missionId = missionIdFromItem(item);
                    const assignedBy =
                      metadataText(item.metadata, [
                        'assigned_by',
                        'assignedBy',
                        'created_by',
                        'createdBy',
                        'requested_by',
                        'requestedBy',
                      ]) || item.source;
                    const assignee =
                      item.assignee_user_id ||
                      item.assignee_peer_id ||
                      metadataText(item.metadata, ['assignee_label', 'assigneeLabel']) ||
                      uxText('chronos_work_item_unassigned', locale);
                    return (
                      <article
                        key={item.item_id}
                        className="rounded-xl border kb-border-subtle kb-surface-raised p-3 text-[11px]"
                      >
                        <div className="font-semibold leading-5 kb-text-primary">{item.title}</div>
                        {item.description && item.description !== item.title ? (
                          <div className="mt-2 line-clamp-3 text-[10px] leading-5 kb-text-secondary">
                            {item.description}
                          </div>
                        ) : null}
                        <div className="mt-3 grid gap-1.5 text-[9px] kb-text-muted">
                          <div className="flex items-center gap-1.5">
                            <CircleUserRound size={11} />
                            <span>{uxText('chronos_work_item_assignee', locale)}:</span>
                            <span className="truncate kb-text-primary">{assignee}</span>
                          </div>
                          <div>
                            {uxText('chronos_work_item_assigned_by', locale)}:{' '}
                            <span className="kb-text-secondary">{assignedBy}</span>
                          </div>
                          <div>
                            {uxText('chronos_work_item_source', locale)}:{' '}
                            <span className="kb-text-secondary">
                              {item.source_ref || item.source}
                            </span>
                          </div>
                          <div>
                            {uxText('chronos_work_item_priority', locale)}:{' '}
                            <span className="kb-text-secondary">{item.priority}</span>
                          </div>
                          <div>
                            {uxText('chronos_work_item_created', locale)}:{' '}
                            {compactDate(item.created_at)} ·{' '}
                            {uxText('chronos_work_item_updated', locale)}:{' '}
                            {compactDate(item.updated_at)}
                          </div>
                        </div>
                        {missionId && onOpenMission ? (
                          <button
                            type="button"
                            onClick={() => onOpenMission(missionId)}
                            className="mt-3 max-w-full truncate rounded-full border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.12em] kb-text-accent"
                          >
                            {missionId}
                          </button>
                        ) : null}
                        <div className="mt-3 flex gap-1">
                          {columnIndex > 0 ? (
                            <button
                              type="button"
                              disabled={busyId === item.item_id}
                              onClick={() => void moveItem(item.item_id, statuses[columnIndex - 1])}
                              className="rounded kb-surface-raised px-2 py-1 text-[10px] kb-text-secondary hover:kb-surface-raised"
                              aria-label={statusLabel(statuses[columnIndex - 1])}
                            >
                              <ArrowLeft size={12} />
                            </button>
                          ) : null}
                          {columnIndex < statuses.length - 1 ? (
                            <button
                              type="button"
                              disabled={busyId === item.item_id}
                              onClick={() => void moveItem(item.item_id, statuses[columnIndex + 1])}
                              className="rounded kb-surface-accent px-2 py-1 text-[10px] kb-text-accent hover:kb-surface-accent"
                              aria-label={statusLabel(statuses[columnIndex + 1])}
                            >
                              <ArrowRight size={12} />
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function coordinationCount(summary: WorkCoordinationSummary, status: string): number {
  if (status === 'in_progress') return summary.inProgress;
  if (status in summary) return Number(summary[status as keyof WorkCoordinationSummary] || 0);
  return 0;
}

function CoordinationMetric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold kb-text-primary">{value}</div>
      <div className="mt-1 text-[10px] leading-4 kb-text-muted">{detail}</div>
    </div>
  );
}
