'use client';

import * as React from 'react';
import { useChronosLocale } from '../lib/hooks';
import { LiveSyncScheduler, bindVisibilityToLiveSync } from '../lib/live-sync';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';

type Attention = {
  event_id: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  kind: string;
  title: string;
  reason: string;
  next_action: string;
};

type CollaborationProjection = {
  revision: number;
  generated_at: string;
  partial: boolean;
  status_flags: Array<'sequence_gap' | 'unknown_event' | 'stale_runtime'>;
  sequence_gaps: Array<{
    source: string;
    previous_seq: number;
    expected_seq: number;
    actual_seq: number;
  }>;
  overview: {
    events: number;
    missions: number;
    tasks: number;
    agents: number;
    active: number;
    blocked: number;
    waiting_human: number;
    review_pending: number;
    failures: number;
    native_subagents: number;
    unavailable_subagents: number;
  };
  events: Array<{
    event_id: string;
    ts: string;
    mission_id?: string;
    task_id?: string;
    agent_id?: string;
    causation_id?: string;
    evidence_refs?: string[];
    kind: string;
    summary: string;
    source: string;
    provider?: string;
    thread_id?: string;
    parent_thread_id?: string;
    turn_id?: string;
    native?: boolean;
    native_fork?: boolean;
    native_mode?: string;
    effort?: 'low' | 'medium' | 'high' | 'ultra';
    native_unavailable?: boolean;
  }>;
  edges: Array<{ from: string; to: string; kind: string; event_id: string }>;
  attention: Attention[];
};

const KIND_LABEL_KEY: Record<string, string> = {
  dispatch: 'chronos_ac_kind_dispatch',
  claim: 'chronos_ac_kind_claim',
  spawn: 'chronos_ac_kind_spawn',
  progress: 'chronos_ac_kind_progress',
  waiting: 'chronos_ac_kind_waiting',
  blocked: 'chronos_ac_kind_blocked',
  handoff: 'chronos_ac_kind_handoff',
  approval: 'chronos_ac_kind_approval',
  review: 'chronos_ac_kind_review',
  artifact: 'chronos_ac_kind_artifact',
  retry: 'chronos_ac_kind_retry',
  failure: 'chronos_ac_kind_failure',
  completion: 'chronos_ac_kind_completion',
  unknown: 'chronos_ac_kind_unknown',
};

export function collaborationKindLabel(kind: string, locale: SupportedLocale): string {
  const key = KIND_LABEL_KEY[kind];
  return key ? uxText(key, locale) : kind;
}

const ACTION_LABEL_KEY: Record<string, string> = {
  approval: 'chronos_ac_action_approval',
  failure: 'chronos_ac_action_failure',
  retry: 'chronos_ac_action_retry',
  handoff: 'chronos_ac_action_handoff',
  waiting: 'chronos_ac_action_mission',
  blocked: 'chronos_ac_action_mission',
  review: 'chronos_ac_action_mission',
};

export function collaborationActionLabel(kind: string, locale: SupportedLocale): string | null {
  const key = ACTION_LABEL_KEY[kind];
  return key ? uxText(key, locale) : null;
}

export function collaborationEvidenceRefs(
  event: { evidence_refs?: string[] } | undefined
): string[] {
  return Array.isArray(event?.evidence_refs)
    ? event.evidence_refs.filter((ref): ref is string => Boolean(ref && ref.trim())).slice(0, 3)
    : [];
}

export function buildCollaborationQuery(tenant: string, missionId: string): string {
  const params = new URLSearchParams();
  if (tenant) params.set('tenant', tenant);
  if (missionId) params.set('mission', missionId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export type CollaborationAttentionAction =
  | {
      mode: 'view';
      viewId:
        'secret-approval-queue' | 'runtime-topology-map' | 'runtime-lease-doctor' | 'trace-viewer';
      label: string;
    }
  | { mode: 'mission'; label: string };

export function attentionActionForKind(kind: string): CollaborationAttentionAction | null {
  switch (kind) {
    case 'approval':
      return { mode: 'view', viewId: 'secret-approval-queue', label: '承認キューを開く' };
    case 'failure':
      return { mode: 'view', viewId: 'runtime-topology-map', label: 'Runtime を確認' };
    case 'retry':
      return { mode: 'view', viewId: 'runtime-lease-doctor', label: '再試行・lease診断を開く' };
    case 'handoff':
      return { mode: 'view', viewId: 'trace-viewer', label: '引き継ぎ履歴を開く' };
    case 'waiting':
    case 'blocked':
    case 'review':
      return { mode: 'mission', label: '停止・再開操作を開く' };
    default:
      return null;
  }
}

function Stat({
  label,
  value,
  tone = 'kb-text-primary',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

/** Read-only projection of human/agent collaboration state. */
export function AgentCollaborationBoard({
  tenant = '',
  onOpenMission,
  onOpenView,
}: {
  tenant?: string;
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
  const [projection, setProjection] = React.useState<CollaborationProjection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [missionId, setMissionId] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);
  const schedulerRef = React.useRef<LiveSyncScheduler<CollaborationProjection> | null>(null);

  const refresh = React.useCallback(() => {
    setRefreshing(true);
    schedulerRef.current?.invalidate();
  }, []);

  const loadProjection = React.useCallback(async () => {
    const query = buildCollaborationQuery(tenant, missionId);
    const response = await fetch(`/api/collaboration${query}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.ok)
      throw new Error(payload.error || uxText('chronos_ac_load_error', locale));
    return payload.projection as CollaborationProjection;
  }, [locale, missionId, tenant]);

  React.useEffect(() => {
    setMissionId('');
  }, [tenant]);

  React.useEffect(() => {
    const scheduler = new LiveSyncScheduler<CollaborationProjection>({
      fetchSnapshot: loadProjection,
      onSnapshot: (snapshot) => {
        setProjection(snapshot);
        setRefreshing(false);
        setError(null);
      },
      onError: (reason) => {
        setRefreshing(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      debounceMs: 120,
      revisionOf: (snapshot) => snapshot.revision,
    });
    schedulerRef.current = scheduler;
    const unbindVisibility = bindVisibilityToLiveSync(scheduler);
    const eventSource =
      typeof window !== 'undefined' && 'EventSource' in window
        ? new EventSource('/api/collaboration/stream')
        : null;
    const invalidate = () => scheduler.invalidate();
    eventSource?.addEventListener('batch', invalidate);
    eventSource?.addEventListener('mission_event', invalidate);
    eventSource?.addEventListener('status_update', invalidate);
    eventSource?.addEventListener('notification', invalidate);
    eventSource?.addEventListener('step_begin', invalidate);
    eventSource?.addEventListener('step_end', invalidate);
    eventSource?.addEventListener('error', invalidate);
    scheduler.start();
    return () => {
      eventSource?.close();
      unbindVisibility();
      scheduler.stop();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [loadProjection]);

  const overview = projection?.overview;
  const eventById = React.useMemo(
    () => new Map((projection?.events || []).map((event) => [event.event_id, event])),
    [projection?.events]
  );
  const missionOptions = React.useMemo(
    () =>
      Array.from(
        new Set(
          (projection?.events || [])
            .map((event) => event.mission_id)
            .filter((value): value is string => Boolean(value))
        )
      ).sort(),
    [projection?.events]
  );
  return (
    <section className="rounded-2xl border kb-border-accent kb-surface-accent p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] kb-text-accent">
            {uxText('chronos_ac_title', locale)}
          </div>
          <div className="mt-1 text-[11px] kb-text-muted">
            {uxText('chronos_ac_description', locale)}
          </div>
        </div>
        <div className="w-full rounded-xl border kb-border-subtle kb-surface-raised px-3 py-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
            {uxText('chronos_ac_guide_title', locale)}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['chronos_ac_guide_who', 'chronos_ac_guide_who_detail'],
              ['chronos_ac_guide_what', 'chronos_ac_guide_what_detail'],
              ['chronos_ac_guide_next', 'chronos_ac_guide_next_detail'],
              ['chronos_ac_guide_act', 'chronos_ac_guide_act_detail'],
            ].map(([labelKey, detailKey]) => (
              <div
                key={labelKey}
                className="rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-2"
              >
                <div className="text-[9px] font-bold tracking-[0.14em] kb-text-accent">
                  {uxText(labelKey, locale)}
                </div>
                <div className="mt-1 text-[10px] kb-text-secondary">
                  {uxText(detailKey, locale)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
          <label
            className="text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted"
            htmlFor="chronos-collaboration-mission-filter"
          >
            {uxText('chronos_ac_filter_mission', locale)}
          </label>
          <select
            id="chronos-collaboration-mission-filter"
            value={missionId}
            onChange={(event) => setMissionId(event.target.value)}
            className="min-w-48 rounded-lg border kb-border-subtle kb-surface-raised px-2 py-1.5 text-[11px] kb-text-primary"
          >
            <option value="">{uxText('chronos_ac_filter_all_missions', locale)}</option>
            {missionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded-lg border kb-border-accent kb-surface-accent px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-accent disabled:opacity-50"
          >
            {refreshing
              ? uxText('chronos_ac_refreshing', locale)
              : uxText('chronos_ac_refresh', locale)}
          </button>
          {projection?.generated_at ? (
            <span className="ml-auto text-[10px] kb-text-muted">
              {uxText('chronos_ac_updated', locale)} {projection.generated_at.slice(11, 19)}
            </span>
          ) : null}
        </div>
        {projection?.partial ? (
          <span className="rounded-full border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning">
            {uxText('chronos_ac_status_attention', locale)}
          </span>
        ) : null}
        {projection?.status_flags.length ? (
          <div className="flex flex-wrap gap-1 text-[10px] kb-status-warning">
            {projection.status_flags.map((flag) => (
              <span key={flag} className="rounded-full border kb-status-warning-border px-2 py-1">
                {flag === 'sequence_gap'
                  ? uxText('chronos_ac_flag_sequence_gap', locale)
                  : flag === 'stale_runtime'
                    ? uxText('chronos_ac_flag_stale_runtime', locale)
                    : uxText('chronos_ac_flag_unknown_event', locale)}
              </span>
            ))}
          </div>
        ) : null}
        {projection?.status_flags.includes('stale_runtime') && onOpenView ? (
          <button
            type="button"
            onClick={() => onOpenView('runtime-topology-map')}
            className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning hover:kb-status-warning-surface"
          >
            {uxText('chronos_ac_check_runtime', locale)}
          </button>
        ) : null}
        {error ? <span className="text-[11px] kb-status-negative">{error}</span> : null}
        <span className="ml-auto rounded-full border kb-border-subtle kb-surface-raised px-2 py-1 text-[10px] kb-text-muted">
          {uxText('chronos_ac_scope', locale)}: {tenant || uxText('chronos_ac_scope_all', locale)}
        </span>
      </div>

      {overview ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label={uxText('chronos_ac_stat_missions', locale)} value={overview.missions} />
          <Stat label={uxText('chronos_ac_stat_tasks', locale)} value={overview.tasks} />
          <Stat label={uxText('chronos_ac_stat_agents', locale)} value={overview.agents} />
          <Stat
            label={uxText('chronos_ac_stat_active', locale)}
            value={overview.active}
            tone="kb-text-accent"
          />
          <Stat
            label={uxText('chronos_ac_stat_blocked', locale)}
            value={overview.blocked}
            tone="kb-status-warning"
          />
          <Stat
            label={uxText('chronos_ac_stat_waiting', locale)}
            value={overview.waiting_human}
            tone="kb-status-warning"
          />
          <Stat
            label={uxText('chronos_ac_stat_review', locale)}
            value={overview.review_pending}
            tone="kb-status-info"
          />
          <Stat
            label={uxText('chronos_ac_stat_failures', locale)}
            value={overview.failures}
            tone="kb-status-negative"
          />
          <Stat
            label={uxText('chronos_ac_stat_native_subagents', locale)}
            value={overview.native_subagents}
            tone="kb-text-accent"
          />
          <Stat
            label={uxText('chronos_ac_stat_unavailable_subagents', locale)}
            value={overview.unavailable_subagents}
            tone="kb-status-warning"
          />
        </div>
      ) : (
        <div className="mt-4 text-[11px] kb-text-muted">{uxText('chronos_ac_loading', locale)}</div>
      )}

      {projection && projection.attention.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-status-warning">
            {uxText('chronos_ac_attention', locale)}
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {projection.attention.slice(0, 6).map((item) => (
              <div
                key={item.event_id}
                className="rounded-xl border kb-status-warning-border kb-status-warning-surface px-3 py-2 text-[11px]"
              >
                {(() => {
                  const event = eventById.get(item.event_id);
                  const evidenceRefs = collaborationEvidenceRefs(event);
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold kb-status-warning">{item.title}</span>
                        <span className="rounded-full border kb-border-subtle px-2 text-[9px] kb-text-muted">
                          {collaborationKindLabel(item.kind, locale)}
                        </span>
                        <span className="ml-auto text-[9px] kb-text-muted">
                          {item.mission_id || uxText('chronos_ac_mission_unspecified', locale)}
                        </span>
                      </div>
                      <div className="mt-1 kb-text-secondary">
                        {uxText('chronos_ac_reason', locale)}: {item.reason}
                      </div>
                      <div className="mt-1 kb-text-accent">
                        {uxText('chronos_ac_next', locale)}: {item.next_action}
                      </div>
                      {event?.causation_id || evidenceRefs.length > 0 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] kb-text-muted">
                          {event?.causation_id ? (
                            <span className="rounded border kb-border-subtle px-2 py-1">
                              {uxText('chronos_ac_cause', locale)}: {event.causation_id}
                            </span>
                          ) : null}
                          {evidenceRefs.length > 0 ? (
                            <span
                              className="rounded border kb-border-subtle px-2 py-1"
                              title={evidenceRefs.join(', ')}
                            >
                              {uxText('chronos_ac_evidence', locale)}: {evidenceRefs.join(', ')}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.mission_id && onOpenMission ? (
                          <button
                            type="button"
                            onClick={() => onOpenMission(item.mission_id as string)}
                            className="rounded border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] kb-text-accent hover:kb-surface-accent"
                          >
                            {uxText('chronos_ac_open_mission', locale)}
                          </button>
                        ) : null}
                        {attentionActionForKind(item.kind)?.mode === 'view' && onOpenView ? (
                          <button
                            type="button"
                            aria-label={collaborationActionLabel(item.kind, locale) || undefined}
                            title={collaborationActionLabel(item.kind, locale) || undefined}
                            onClick={() => {
                              const action = attentionActionForKind(item.kind);
                              if (action?.mode === 'view') onOpenView(action.viewId);
                            }}
                            className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning hover:kb-status-warning-surface"
                          >
                            {collaborationActionLabel(item.kind, locale)}
                          </button>
                        ) : null}
                        {attentionActionForKind(item.kind)?.mode === 'mission' &&
                        item.mission_id &&
                        onOpenMission ? (
                          <button
                            type="button"
                            aria-label={collaborationActionLabel(item.kind, locale) || undefined}
                            title={collaborationActionLabel(item.kind, locale) || undefined}
                            onClick={() => onOpenMission(item.mission_id as string)}
                            className="rounded border kb-status-warning-border kb-status-warning-surface px-2 py-1 text-[10px] kb-status-warning hover:kb-status-warning-surface"
                          >
                            {collaborationActionLabel(item.kind, locale)}
                          </button>
                        ) : null}
                        {evidenceRefs.length > 0 && onOpenView ? (
                          <button
                            type="button"
                            aria-label={uxText('chronos_ac_open_evidence', locale)}
                            title={uxText('chronos_ac_open_evidence', locale)}
                            onClick={() => onOpenView('trace-viewer')}
                            className="rounded border kb-border-subtle kb-surface-raised px-2 py-1 text-[10px] kb-text-secondary hover:kb-surface-raised"
                          >
                            {uxText('chronos_ac_open_evidence', locale)}
                          </button>
                        ) : null}
                      </div>
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {projection && projection.events.length > 0 ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
              {uxText('chronos_ac_timeline', locale)}
            </div>
            <div className="grid gap-1">
              {projection.events.slice(0, 8).map((event) => (
                <div
                  key={event.event_id}
                  className="flex gap-2 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px]"
                >
                  <span className="w-14 shrink-0 kb-text-muted">{event.ts.slice(11, 19)}</span>
                  <span className="rounded-full border kb-border-accent px-2 kb-text-accent">
                    {collaborationKindLabel(event.kind, locale)}
                  </span>
                  <span className="min-w-0 truncate kb-text-secondary">{event.summary}</span>
                  {event.task_id ? (
                    <span className="shrink-0 rounded border kb-border-subtle px-1.5 kb-text-muted">
                      {uxText('chronos_ac_task', locale)}: {event.task_id}
                    </span>
                  ) : null}
                  {event.native ? (
                    <span className="shrink-0 rounded border kb-border-accent px-1.5 kb-text-accent">
                      {uxText('chronos_ac_native', locale)}
                      {event.provider ? ` · ${event.provider}` : ''}
                      {event.native_fork ? ' · fork' : ' · parent'}
                      {event.effort ? ` · ${event.effort}` : ''}
                    </span>
                  ) : event.native_unavailable ? (
                    <span className="shrink-0 rounded border kb-status-warning-border px-1.5 kb-status-warning">
                      {uxText('chronos_ac_native_unavailable', locale)}
                    </span>
                  ) : null}
                  {event.thread_id ? (
                    <span
                      className="shrink-0 rounded border kb-border-subtle px-1.5 kb-text-muted"
                      title={event.thread_id}
                    >
                      {uxText('chronos_ac_thread', locale)}: {event.thread_id.slice(0, 8)}
                    </span>
                  ) : null}
                  {collaborationEvidenceRefs(event).length > 0 ? (
                    <span className="shrink-0 rounded border kb-border-subtle px-1.5 kb-text-muted">
                      {uxText('chronos_ac_evidence', locale)}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 kb-text-muted">
                    {event.agent_id || event.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-muted">
              {uxText('chronos_ac_handoff_graph', locale)}
            </div>
            <div className="grid gap-1">
              {projection.edges.slice(-8).map((edge) => (
                <div
                  key={`${edge.event_id}:${edge.from}:${edge.to}`}
                  className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] kb-text-secondary"
                >
                  <span className="kb-text-accent">{edge.from}</span>
                  <span className="mx-2 kb-text-muted">→</span>
                  <span className="kb-status-info">{edge.to}</span>
                  <span className="ml-2 kb-text-muted">
                    {collaborationKindLabel(edge.kind, locale)}
                  </span>
                </div>
              ))}
              {projection.edges.length === 0 ? (
                <div className="text-[11px] kb-text-muted">
                  {uxText('chronos_ac_no_graph', locale)}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
