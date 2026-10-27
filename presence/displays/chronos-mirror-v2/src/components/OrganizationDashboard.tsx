'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Badge, Button, Callout, Metric, Section } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/locale-normalize';
import {
  workspaceQuery,
  workspaceSectionHref,
  workspaceSelectionFromQuery,
} from '@agent/core/surface/workspace-query';
import type { DashboardMode, OrganizationDashboardData } from '../lib/organization-dashboard';
import { parseOrganizationDashboard } from '../lib/organization-dashboard-response';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

/** Scope keys also guard rendering, so a prior response cannot flash in another view. */
export function OrganizationDashboard() {
  const locale = useChronosLocale();
  const messages: Record<string, string> = {
    title: uxText('chronos_dashboard_title', locale),
    description: uxText('chronos_dashboard_description', locale),
    views: uxText('chronos_dashboard_views', locale),
    organization: uxText('chronos_dashboard_organization', locale),
    scope: uxText('chronos_dashboard_scope', locale),
    mine: uxText('chronos_dashboard_mine', locale),
    refresh: uxText('chronos_dashboard_refresh', locale),
    access_hint: uxText('chronos_dashboard_access_hint', locale),
    unavailable: uxText('chronos_dashboard_unavailable', locale),
    loading: uxText('chronos_dashboard_loading', locale),
    all_authorized: uxText('chronos_dashboard_all_authorized', locale),
    viewer: uxText('chronos_dashboard_viewer', locale),
    role: uxText('chronos_dashboard_role', locale),
    tenant: uxText('chronos_dashboard_tenant', locale),
    project: uxText('chronos_dashboard_project', locale),
    operation: uxText('chronos_dashboard_operation', locale),
    tier: uxText('chronos_dashboard_tier', locale),
    updated: uxText('chronos_dashboard_updated', locale),
    active: uxText('chronos_dashboard_active', locale),
    blocked: uxText('chronos_dashboard_blocked', locale),
    review: uxText('chronos_dashboard_review', locale),
    ready: uxText('chronos_dashboard_work_ready', locale),
    next: uxText('chronos_dashboard_next', locale),
    action_blocked: uxText('chronos_dashboard_action_blocked', locale),
    action_review: uxText('chronos_dashboard_action_review', locale),
    action_ready: uxText('chronos_dashboard_action_ready', locale),
    empty: uxText('chronos_dashboard_empty', locale),
    limited: uxText('chronos_dashboard_limited', locale),
    open_work: uxText('chronos_dashboard_open_work', locale),
    open_decisions: uxText('chronos_dashboard_open_decisions', locale),
    open_resources: uxText('chronos_dashboard_open_resources', locale),
    mine_hint: uxText('chronos_dashboard_mine_hint', locale),
  };
  const t = (key: string) => messages[key];
  const search = useSearchParams().toString();
  const base = workspaceQuery(workspaceSelectionFromQuery(new URLSearchParams(search))).toString();
  const [choice, setChoice] = React.useState<{
    base: string;
    mode: DashboardMode;
    organizationQuery?: string;
  } | null>(null);
  const mode = choice?.base === base ? choice.mode : 'scope';
  const query = new URLSearchParams(
    mode === 'organization' ? (choice?.organizationQuery ?? base) : base
  );
  if (mode === 'organization') {
    query.delete('project_id');
    query.delete('operation_id');
  }
  query.set('mode', mode);
  const key = query.toString();
  const [result, setResult] = React.useState<{
    key: string;
    data: OrganizationDashboardData;
  } | null>(null);
  const [failure, setFailure] = React.useState<{ key: string } | null>(null);
  const [reload, setReload] = React.useState(0);
  const data = result?.key === key && !failure ? result.data : null;
  React.useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setFailure(null);
    void fetch('/api/organization-dashboard?' + key, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = parseOrganizationDashboard(await response.json());
        if (!response.ok || !payload || payload.mode !== mode)
          throw new Error('Dashboard unavailable');
        if (!controller.signal.aborted) setResult({ key, data: payload });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailure({ key });
      });
    return () => controller.abort();
  }, [key, mode, reload]);
  const scopeText = (value: string[] | 'all') =>
    value === 'all' ? t('all_authorized') : value.join(', ') || '—';
  return (
    <Section title={t('title')} description={t('description')}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('views')}>
        {(['organization', 'scope', 'mine'] as const).map((view) => (
          <Button
            key={view}
            label={t(view)}
            variant={mode === view ? 'primary' : 'secondary'}
            disabled={view !== 'scope' && (!data || !data.available[view])}
            onClick={() =>
              setChoice({
                base,
                mode: view,
                organizationQuery: data ? workspaceQuery(data.selection).toString() : undefined,
              })
            }
          />
        ))}
        <Button
          label={t('refresh')}
          variant="ghost"
          onClick={() => setReload((value) => value + 1)}
        />
      </div>
      <p className="kb-text kb-text--muted">{t('access_hint')}</p>
      {failure?.key === key ? (
        <div role="alert">
          <Callout tone="warning" title={t('unavailable')} />
        </div>
      ) : null}
      {!data && failure?.key !== key ? <p role="status">{t('loading')}</p> : null}
      {data ? (
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge label={t('viewer') + ': ' + data.viewer.id} />
            <Badge label={t('role') + ': ' + data.viewer.role} />
            <Badge label={t('tenant') + ': ' + scopeText(data.viewer.tenants)} />
            <Badge label={t('organization') + ': ' + scopeText(data.viewer.organizations)} />
            <Badge label={t('project') + ': ' + scopeText(data.viewer.projects)} />
            {data.selection.operation_id ? (
              <Badge label={t('operation') + ': ' + data.selection.operation_id} />
            ) : null}
            <Badge label={t('tier') + ': ' + data.viewer.tiers.join(', ')} />
          </div>
          <p>
            {t('updated')}{' '}
            <time dateTime={data.generatedAt}>
              {new Date(data.generatedAt).toLocaleString(localeToBcp47(locale))}
            </time>
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(['active', 'blocked', 'review', 'ready'] as const).map((status) => (
              <Metric key={status} label={t(status)} value={data.counts[status]} />
            ))}
          </div>
          <h3>{t('next')}</h3>
          {data.attention.length ? (
            <ul className="grid gap-3">
              {data.attention.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong> · {t(item.status)}
                  <p>{t('action_' + item.status)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('empty')}</p>
          )}
          {data.attentionTotal > data.attention.length ? <p>{t('limited')}</p> : null}
          <a className="kb-link" href={workspaceSectionHref('work-items', data.selection)}>
            {t('open_work')}
          </a>
          {mode === 'mine' ? (
            <p>{t('mine_hint')}</p>
          ) : (
            <>
              <a className="kb-link" href={workspaceSectionHref('approvals', data.selection)}>
                {t('open_decisions')}
              </a>
              <a className="kb-link" href={workspaceSectionHref('deliverables', data.selection)}>
                {t('open_resources')}
              </a>
            </>
          )}
        </div>
      ) : null}
    </Section>
  );
}
