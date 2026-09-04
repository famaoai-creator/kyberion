'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleStop, Play, RefreshCw } from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';
import {
  parseSurfaceControlActionResponse,
  parseSurfaceControlResponse,
  type ClientSurfaceControlAction,
  type ClientSurfaceControlActionSummary,
  type ClientSurfaceSummary,
  type SurfaceControlResponse,
} from '../lib/surface-control-response';

type ActionDefinition = ClientSurfaceControlAction;
type Surface = ClientSurfaceSummary;
type ActionSummary = ClientSurfaceControlActionSummary;
type IntelligencePayload = SurfaceControlResponse;

const EMPTY_PAYLOAD: IntelligencePayload = {
  surfaces: [],
  controlActions: [],
  controlActionAvailability: { globalSurface: [], surface: {} },
};

export function SurfaceControlWorkspace({ tenant }: { tenant?: string }) {
  const locale = useChronosLocale();
  const [data, setData] = React.useState<IntelligencePayload>(EMPTY_PAYLOAD);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [pendingAction, setPendingAction] = React.useState<{
    surfaceId: string | null;
    action: ActionDefinition;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [surfaceQuery, setSurfaceQuery] = React.useState('');
  const [surfaceFilter, setSurfaceFilter] = React.useState<
    'all' | 'attention' | 'running' | 'stopped'
  >('all');

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(
        `/api/intelligence${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
        { cache: 'no-store' }
      );
      const payload = parseSurfaceControlResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid surface control response');
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const execute = React.useCallback(
    async (surfaceId: string | null, action: ActionDefinition) => {
      const key = `${surfaceId || 'all'}:${action.operation}`;
      setBusyKey(key);
      try {
        const response = await fetch('/api/intelligence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'surface_control',
            surfaceId,
            operation: action.operation,
          }),
        });
        const payload = parseSurfaceControlActionResponse(await response.json().catch(() => null));
        if (!response.ok || !payload) throw new Error('Invalid surface control action response');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
        setPendingAction(null);
      }
    },
    [refresh]
  );

  const requestAction = (surfaceId: string | null, action: ActionDefinition) => {
    if (!action.enabled) return;
    if (action.risk === 'risky') {
      setPendingAction({ surfaceId, action });
      return;
    }
    void execute(surfaceId, action);
  };

  const latestAction = (target: string): ActionSummary | null =>
    data.controlActions.find((action) => action.kind === 'surface' && action.target === target) ||
    null;

  const visibleSurfaces = React.useMemo(() => {
    const query = surfaceQuery.trim().toLowerCase();
    return [...data.surfaces]
      .filter((surface) => {
        if (surfaceFilter === 'running' && !surface.running) return false;
        if (surfaceFilter === 'stopped' && surface.running) return false;
        if (
          surfaceFilter === 'attention' &&
          !['unhealthy', 'degraded', 'unknown'].includes(surface.health.toLowerCase())
        ) {
          return false;
        }
        if (!query) return true;
        return [surface.id, surface.kind, surface.detail, surface.controlSummary]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .sort(
        (left, right) =>
          Number(['unhealthy', 'degraded', 'unknown'].includes(right.health.toLowerCase())) -
          Number(['unhealthy', 'degraded', 'unknown'].includes(left.health.toLowerCase()))
      );
  }, [data.surfaces, surfaceFilter, surfaceQuery]);

  const surfaceAttentionCount = data.surfaces.filter((surface) =>
    ['unhealthy', 'degraded', 'unknown'].includes(surface.health.toLowerCase())
  ).length;

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_nav_surface_control', locale)}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight kb-text-primary">
            {uxText('chronos_surface_control', locale)}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 kb-text-secondary">
            {uxText('chronos_surface_control_description', locale)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-xl border kb-border-subtle kb-surface-sunken p-2 kb-text-secondary"
          aria-label={uxText('chronos_refresh', locale)}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}

      {pendingAction ? (
        <div className="mt-4 rounded-2xl border kb-status-warning-border kb-status-warning-surface p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="mt-0.5 kb-status-warning" />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold kb-status-warning">
                {uxText('chronos_surface_control_confirm_title', locale)}
              </div>
              <div className="mt-1 text-[11px] kb-text-secondary">
                {surfaceActionLabel(pendingAction.action, locale)} ·{' '}
                {pendingAction.surfaceId || uxText('chronos_surfaces', locale)}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void execute(pendingAction.surfaceId, pendingAction.action)}
                  className="rounded-lg border kb-status-warning-border kb-status-warning-surface px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-status-warning"
                >
                  {uxText('chronos_surface_control_confirm', locale)}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingAction(null)}
                  className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary"
                >
                  {uxText('chronos_cb_back', locale)}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-5 rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] kb-text-secondary">
          <Play size={13} />
          {uxText('chronos_surface_control_global', locale)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.controlActionAvailability.globalSurface.map((action) => (
            <ActionButton
              key={action.operation}
              action={action}
              busy={busyKey === `all:${action.operation}`}
              locale={locale}
              onClick={() => requestAction(null, action)}
            />
          ))}
          {data.controlActionAvailability.globalSurface.length === 0 ? (
            <span className="text-[11px] kb-text-muted">
              {uxText('chronos_surface_control_no_actions', locale)}
            </span>
          ) : null}
        </div>
        {latestAction('surface-runtime') ? (
          <ActionStatus action={latestAction('surface-runtime') as ActionSummary} locale={locale} />
        ) : null}
      </div>

      <div className="mt-4 grid gap-3">
        {data.surfaces.length === 0 ? (
          <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-5 text-[11px] kb-text-muted">
            {uxText('chronos_no_managed_surfaces', locale)}
          </div>
        ) : (
          <>
            <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] kb-text-secondary">
                  {uxText('chronos_surface_list_detail', locale)}
                </div>
                <div className="flex flex-wrap gap-2 text-[10px]">
                  <span className="rounded-full kb-status-warning-surface px-2 py-1 kb-status-warning">
                    {uxText('chronos_attention', locale)} {surfaceAttentionCount}
                  </span>
                  <span className="rounded-full kb-surface-raised px-2 py-1 kb-text-secondary">
                    {uxText('chronos_surface_visible_count', locale)} {visibleSurfaces.length}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={surfaceQuery}
                  onChange={(event) => setSurfaceQuery(event.target.value)}
                  placeholder={uxText('chronos_surface_search_placeholder', locale)}
                  aria-label={uxText('chronos_surface_search_label', locale)}
                  className="min-w-[220px] flex-1 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2 text-[11px] kb-text-primary placeholder:kb-text-muted"
                />
                <select
                  value={surfaceFilter}
                  onChange={(event) => setSurfaceFilter(event.target.value as typeof surfaceFilter)}
                  aria-label={uxText('chronos_surface_filter_label', locale)}
                  className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2 text-[11px] kb-text-primary"
                >
                  <option value="all">{uxText('chronos_surface_filter_all', locale)}</option>
                  <option value="attention">
                    {uxText('chronos_surface_filter_attention', locale)}
                  </option>
                  <option value="running">
                    {uxText('chronos_surface_filter_running', locale)}
                  </option>
                  <option value="stopped">
                    {uxText('chronos_surface_filter_stopped', locale)}
                  </option>
                </select>
              </div>
            </div>
            {visibleSurfaces.length === 0 ? (
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-5 text-[11px] kb-text-muted">
                {uxText('chronos_surface_no_matches', locale)}
              </div>
            ) : null}
            {visibleSurfaces.map((surface) => {
              const actions = data.controlActionAvailability.surface[surface.id] || [];
              return (
                <article
                  key={surface.id}
                  className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold kb-text-primary">{surface.id}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                        {surfaceKindLabel(surface.kind, locale)} ·{' '}
                        {surfaceStateLabel(surface.running ? 'running' : 'stopped', locale)} ·{' '}
                        {surfaceStateLabel(surface.health, locale)}
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${surface.running ? 'kb-status-positive-surface kb-status-positive' : 'kb-surface-raised kb-text-secondary'}`}
                    >
                      {surface.running ? (
                        <CheckCircle2 size={11} className="inline" />
                      ) : (
                        <CircleStop size={11} className="inline" />
                      )}{' '}
                      {surfaceStateLabel(surface.health, locale)}
                    </div>
                  </div>
                  {surface.detail ? (
                    <div className="mt-2 text-[10px] kb-text-muted">{surface.detail}</div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {actions.map((action) => (
                      <ActionButton
                        key={action.operation}
                        action={action}
                        busy={busyKey === `${surface.id}:${action.operation}`}
                        locale={locale}
                        onClick={() => requestAction(surface.id, action)}
                      />
                    ))}
                  </div>
                  {latestAction(surface.id) ? (
                    <ActionStatus
                      action={latestAction(surface.id) as ActionSummary}
                      locale={locale}
                    />
                  ) : null}
                </article>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

function ActionButton({
  action,
  busy,
  locale,
  onClick,
}: {
  action: ActionDefinition;
  busy: boolean;
  locale: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!action.enabled || busy}
      title={action.disabledReason}
      className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:cursor-not-allowed disabled:opacity-40 ${action.risk === 'risky' ? 'kb-status-negative-border kb-status-negative-surface kb-status-negative' : 'kb-border-accent kb-surface-accent kb-text-accent'}`}
    >
      {busy ? uxText('chronos_working', locale) : surfaceActionLabel(action, locale)}
    </button>
  );
}

function ActionStatus({ action, locale }: { action: ActionSummary; locale: string }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-[10px] kb-text-muted">
      <span>{surfaceActionLabel({ ...action, risk: 'safe', enabled: true }, locale)}</span>
      <span className="font-mono kb-text-secondary">
        {surfaceStatusLabel(action.status, locale)}
      </span>
      {action.requested_by ? (
        <span>
          {uxText('chronos_requested_by', locale)} {action.requested_by}
        </span>
      ) : null}
      {action.error ? <span className="kb-status-negative">{action.error}</span> : null}
    </div>
  );
}

function surfaceStatusLabel(value: ActionSummary['status'], locale: string) {
  const keyByValue: Record<ActionSummary['status'], string> = {
    queued: 'chronos_action_queued',
    completed: 'chronos_action_completed',
    failed: 'chronos_action_failed',
  };
  return uxText(keyByValue[value], locale);
}

function surfaceActionLabel(action: Pick<ActionDefinition, 'operation'>, locale: string) {
  const keyByOperation: Record<string, string> = {
    reconcile: 'chronos_surface_reconcile',
    refresh: 'chronos_surface_refresh',
    start: 'chronos_surface_start',
    stop: 'chronos_surface_stop',
  };
  const key = keyByOperation[action.operation];
  return key ? uxText(key, locale) : action.label;
}

function surfaceKindLabel(kind: string, locale: string) {
  return kind.toLowerCase() === 'ui' ? uxText('chronos_surface_kind_ui', locale) : kind;
}

function surfaceStateLabel(value: string, locale: string) {
  const keyByValue: Record<string, string> = {
    running: 'chronos_surface_running',
    stopped: 'chronos_surface_stopped',
    healthy: 'chronos_surface_healthy',
    unhealthy: 'chronos_surface_unhealthy',
    degraded: 'chronos_surface_degraded',
    unknown: 'chronos_surface_unknown',
  };
  const key = keyByValue[value.toLowerCase()];
  return key ? uxText(key, locale) : value;
}
