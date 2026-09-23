'use client';

import * as React from 'react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { Badge, Button, Callout, Section, Select, Table, TextField } from '@agent/shared-ui';
import { ChronosFieldScope, ChronosInline, ChronosMeta, ChronosToolbar } from './chronos-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import {
  parseSurfaceControlActionResponse,
  parseSurfaceControlResponse,
  type ClientSurfaceControlAction,
  type ClientSurfaceControlActionSummary,
  type SurfaceControlResponse,
} from '../lib/surface-control-response';

type ActionDefinition = ClientSurfaceControlAction;
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

  const onFieldChange = (name: string, value: unknown) => {
    const text = typeof value === 'string' ? value : '';
    if (name === 'surface_query') setSurfaceQuery(text);
    else if (
      name === 'surface_filter' &&
      (text === 'all' || text === 'attention' || text === 'running' || text === 'stopped')
    ) {
      setSurfaceFilter(text);
    }
  };
  const globalLatest = latestAction('surface-runtime');

  return (
    <Section
      title={uxText('chronos_surface_control', locale)}
      description={uxText('chronos_surface_control_description', locale)}
      actions={[
        {
          label: uxText('chronos_refresh', locale),
          variant: 'ghost',
          onClick: () => void refresh(),
        },
      ]}
    >
      {error ? <Callout tone="danger" title={error} /> : null}

      {pendingAction ? (
        <Callout
          tone="warning"
          title={uxText('chronos_surface_control_confirm_title', locale)}
          body={`${surfaceActionLabel(pendingAction.action, locale)} · ${
            pendingAction.surfaceId || uxText('chronos_surfaces', locale)
          }`}
        >
          <ChronosInline>
            <Button
              variant="danger"
              label={uxText('chronos_surface_control_confirm', locale)}
              onClick={() => void execute(pendingAction.surfaceId, pendingAction.action)}
            />
            <Button
              variant="ghost"
              label={uxText('chronos_cb_back', locale)}
              onClick={() => setPendingAction(null)}
            />
          </ChronosInline>
        </Callout>
      ) : null}

      <Section headingLevel={3} title={uxText('chronos_surface_control_global', locale)}>
        <ChronosInline>
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
            <ChronosMeta>{uxText('chronos_surface_control_no_actions', locale)}</ChronosMeta>
          ) : null}
        </ChronosInline>
        {globalLatest ? <ActionStatus action={globalLatest} locale={locale} /> : null}
      </Section>

      <Section
        headingLevel={3}
        title={uxText('chronos_surfaces', locale)}
        description={uxText('chronos_surface_list_detail', locale)}
      >
        <ChronosFieldScope onChange={onFieldChange}>
          <ChronosToolbar>
            <TextField
              name="surface_query"
              type="search"
              label={uxText('chronos_surface_search_label', locale)}
              hide_label
              placeholder={uxText('chronos_surface_search_placeholder', locale)}
              value={surfaceQuery}
            />
            <Select
              name="surface_filter"
              label={uxText('chronos_surface_filter_label', locale)}
              hide_label
              value={surfaceFilter}
              options={[
                { value: 'all', label: uxText('chronos_surface_filter_all', locale) },
                { value: 'attention', label: uxText('chronos_surface_filter_attention', locale) },
                { value: 'running', label: uxText('chronos_surface_filter_running', locale) },
                { value: 'stopped', label: uxText('chronos_surface_filter_stopped', locale) },
              ]}
            />
            <div className="chronos-toolbar__end">
              <ChronosInline>
                <Badge
                  tone={surfaceAttentionCount > 0 ? 'warning' : 'neutral'}
                  label={`${uxText('chronos_attention', locale)} ${surfaceAttentionCount}`}
                />
                <Badge
                  label={`${uxText('chronos_surface_visible_count', locale)} ${visibleSurfaces.length}`}
                />
              </ChronosInline>
            </div>
          </ChronosToolbar>
        </ChronosFieldScope>
        <Table
          columns={[
            { key: 'surface', label: uxText('chronos_surface_col_surface', locale) },
            { key: 'running', label: uxText('chronos_surface_col_running', locale), width: '8rem' },
            { key: 'health', label: uxText('chronos_surface_col_health', locale), width: '8rem' },
            { key: 'actions', label: uxText('chronos_surface_col_actions', locale), align: 'end' },
          ]}
          row_key="id"
          empty={
            data.surfaces.length === 0
              ? uxText('chronos_no_managed_surfaces', locale)
              : uxText('chronos_surface_no_matches', locale)
          }
          rows={visibleSurfaces.map((surface) => {
            const actions = data.controlActionAvailability.surface[surface.id] || [];
            const latest = latestAction(surface.id);
            return {
              id: surface.id,
              surface: (
                <span className="chronos-work-cell">
                  <span className="chronos-work-cell__title">{surface.id}</span>
                  <ChronosMeta>
                    {[surfaceKindLabel(surface.kind, locale), surface.detail]
                      .filter(Boolean)
                      .join(' · ')}
                  </ChronosMeta>
                  {latest ? <ActionStatus action={latest} locale={locale} /> : null}
                </span>
              ),
              running: {
                status: surface.running ? 'running' : 'stopped',
                label: surfaceStateLabel(surface.running ? 'running' : 'stopped', locale),
              },
              health: {
                status: HEALTH_STATUS[surface.health.toLowerCase()] || 'n/a',
                label: surfaceStateLabel(surface.health, locale),
              },
              actions: (
                <ChronosInline>
                  {actions.map((action) => (
                    <ActionButton
                      key={action.operation}
                      action={action}
                      busy={busyKey === `${surface.id}:${action.operation}`}
                      locale={locale}
                      onClick={() => requestAction(surface.id, action)}
                    />
                  ))}
                </ChronosInline>
              ),
            };
          })}
        />
      </Section>
    </Section>
  );
}

/** Surface health → canonical `ui:status-pill` status. */
const HEALTH_STATUS: Record<string, KbStatus> = {
  healthy: 'ready',
  degraded: 'degraded',
  unhealthy: 'error',
  unknown: 'n/a',
};

function ActionButton({
  action,
  busy,
  locale,
  onClick,
}: {
  action: ActionDefinition;
  busy: boolean;
  locale: SupportedLocale;
  onClick: () => void;
}) {
  return (
    <span title={action.disabledReason}>
      <Button
        variant={action.risk === 'risky' ? 'danger' : 'secondary'}
        disabled={!action.enabled || busy}
        label={busy ? uxText('chronos_working', locale) : surfaceActionLabel(action, locale)}
        onClick={onClick}
      />
    </span>
  );
}

function ActionStatus({ action, locale }: { action: ActionSummary; locale: SupportedLocale }) {
  return (
    <ChronosMeta>
      {[
        surfaceActionLabel(action, locale),
        surfaceStatusLabel(action.status, locale),
        action.requested_by
          ? `${uxText('chronos_requested_by', locale)} ${action.requested_by}`
          : '',
        action.error || '',
      ]
        .filter(Boolean)
        .join(' · ')}
    </ChronosMeta>
  );
}

function surfaceStatusLabel(value: ActionSummary['status'], locale: SupportedLocale) {
  const keyByValue: Record<ActionSummary['status'], string> = {
    queued: 'chronos_action_queued',
    completed: 'chronos_action_completed',
    failed: 'chronos_action_failed',
  };
  return uxText(keyByValue[value], locale);
}

function surfaceActionLabel(
  action: { operation: string; label?: string },
  locale: SupportedLocale
) {
  const keyByOperation: Record<string, string> = {
    reconcile: 'chronos_surface_reconcile',
    refresh: 'chronos_surface_refresh',
    start: 'chronos_surface_start',
    stop: 'chronos_surface_stop',
  };
  const key = keyByOperation[action.operation];
  return key ? uxText(key, locale) : action.label || action.operation;
}

function surfaceKindLabel(kind: string, locale: SupportedLocale) {
  return kind.toLowerCase() === 'ui' ? uxText('chronos_surface_kind_ui', locale) : kind;
}

function surfaceStateLabel(value: string, locale: SupportedLocale) {
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
