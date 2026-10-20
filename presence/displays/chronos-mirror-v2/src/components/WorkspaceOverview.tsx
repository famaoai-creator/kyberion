'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Section, Button, Callout, KeyValue, Badge } from '@agent/shared-ui';
import type { WorkspaceOverview as WorkspaceData } from '@agent/core/surface/workspace';
import {
  workspaceQuery,
  workspaceSelectionFromQuery,
  workspaceSectionHref,
} from '@agent/core/surface/workspace-query';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function parseWorkspaceOverview(value: unknown): WorkspaceData | null {
  if (
    !record(value) ||
    value.ok !== true ||
    !record(value.selection) ||
    !record(value.owner) ||
    typeof value.owner.id !== 'string' ||
    typeof value.owner.name !== 'string' ||
    typeof value.owner.kind !== 'string' ||
    !(value.goal === null || typeof value.goal === 'string') ||
    !record(value.work) ||
    !record(value.work.counts) ||
    !['total', 'active', 'blocked'].every(
      (key) =>
        typeof (value.work as Record<string, unknown>).counts === 'object' &&
        typeof (value.work as { counts: Record<string, unknown> }).counts[key] === 'number'
    ) ||
    !Array.isArray(value.work.items) ||
    !record(value.library) ||
    !Array.isArray(value.library.artifacts) ||
    !record(value.decisions) ||
    !Array.isArray(value.decisions.approvals) ||
    !record(value.autonomy) ||
    !Array.isArray(value.unavailable) ||
    !value.unavailable.every((source) => typeof source === 'string') ||
    !Array.isArray(value.autonomy.dots) ||
    !Array.isArray(value.autonomy.blockedReasons) ||
    !value.autonomy.blockedReasons.every((reason) => typeof reason === 'string') ||
    value.autonomy.pauseMeaning !== 'future_wakeups_only' ||
    !record(value.capabilities) ||
    typeof value.capabilities.canControlAutonomy !== 'boolean'
  )
    return null;
  if (
    ![...value.work.items, ...value.decisions.approvals].every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.status === 'string'
    ) ||
    !value.library.artifacts.every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.kind === 'string'
    ) ||
    !value.autonomy.dots.every(
      (dot) =>
        record(dot) &&
        typeof dot.id === 'string' &&
        typeof dot.name === 'string' &&
        typeof dot.status === 'string' &&
        typeof dot.goal === 'string' &&
        record(dot.readiness) &&
        typeof dot.readiness.ready === 'boolean' &&
        Array.isArray(dot.readiness.errors) &&
        dot.readiness.errors.every((error) => typeof error === 'string') &&
        (dot.budget === null ||
          (record(dot.budget) &&
            ['tokens', 'costUsd'].every(
              (key) => typeof (dot.budget as Record<string, unknown>)[key] === 'number'
            ) &&
            ['organization', 'tenant', 'system'].includes(String(dot.budget.scope)) &&
            ['normal', 'soft', 'hard'].includes(String(dot.budget.throttle)) &&
            (dot.budget.costStatus === undefined ||
              ['unknown', 'partial'].includes(String(dot.budget.costStatus)))))
    )
  )
    return null;
  if (value.links !== undefined) {
    if (!record(value.links) || typeof value.links.conversation !== 'string') return null;
    for (const target of [value.links.conversation, value.links.addResource]) {
      if (target === undefined) continue;
      if (typeof target !== 'string') return null;
      try {
        const url = new URL(target);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          return null;
      } catch {
        return null;
      }
    }
  }
  return value as unknown as WorkspaceData;
}

/** One scoped starting point. Its selection is a hint; the server owns visibility and control. */
export function WorkspaceOverview() {
  const locale = useChronosLocale();
  const search = useSearchParams().toString();
  const query = workspaceQuery(workspaceSelectionFromQuery(new URLSearchParams(search))).toString();
  const [data, setData] = React.useState<WorkspaceData | null>(null);
  const [loadedQuery, setLoadedQuery] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const current = React.useRef(query);
  const mutationInFlight = React.useRef(false);
  current.current = query;
  React.useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void fetch('/api/workspace' + (query ? '?' + query : ''), { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        const parsed = parseWorkspaceOverview(payload);
        if (!response.ok || !parsed)
          throw new Error(
            record(payload) && typeof payload.error === 'string'
              ? payload.error
              : uxText(
                  'chronos_workspace_workspace_unavailable_check_the_selection_and_access',
                  locale
                )
          );
        if (!cancelled && current.current === query) {
          setData(parsed);
          setLoadedQuery(query);
        }
      })
      .catch((reason) => {
        if (!cancelled && current.current === query)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [query, reload, locale]);

  const control = async (dotId: string, action: 'pause' | 'resume' | 'activate') => {
    if (
      !data ||
      loadedQuery !== query ||
      mutationInFlight.current ||
      !data.capabilities.canControlAutonomy
    )
      return;
    mutationInFlight.current = true;
    const selection = workspaceSelectionFromQuery(workspaceQuery(data.selection));
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/workspace/autonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selection, dot_id: dotId, action }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !record(payload) || payload.ok !== true)
        throw new Error(
          record(payload) && typeof payload.error === 'string'
            ? payload.error
            : uxText(
                'chronos_workspace_control_outcome_unconfirmed_refresh_to_verify_the_state',
                locale
              )
        );
      if (current.current === query) setReload((value) => value + 1);
    } catch (reason) {
      if (current.current === query)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div aria-busy={busy || ((!data || loadedQuery !== query) && !error)}>
      <Section
        title={
          (loadedQuery === query ? data?.owner.name : null) ||
          uxText('chronos_workspace_workspace', locale)
        }
        description={uxText(
          'chronos_workspace_keep_goals_work_resources_and_decisions_in_the',
          locale
        )}
      >
        <Button
          label={uxText('chronos_workspace_refresh', locale)}
          variant="secondary"
          disabled={busy}
          onClick={() => setReload((value) => value + 1)}
        />
        {error ? (
          <div role="alert">
            <Callout tone="warning" title={error} />
          </div>
        ) : null}
        {busy ? (
          <p role="status" aria-live="polite">
            {uxText('chronos_workspace_control_pending', locale)}
          </p>
        ) : null}
        {(!data || loadedQuery !== query) && !error ? (
          <p role="status">{uxText('chronos_workspace_loading', locale)}</p>
        ) : null}
        {data && loadedQuery === query ? (
          <div className="grid gap-4">
            {data.selection.tier === 'personal' ? (
              <p role="note">{uxText('chronos_workspace_personal_channels_unavailable', locale)}</p>
            ) : null}
            <Badge label={data.owner.kind + ' · ' + data.owner.id} tone="accent" />
            {data.unavailable.map((source) => (
              <Callout
                key={source}
                tone="warning"
                title={uxText('chronos_workspace_unavailable', locale) + source}
              />
            ))}
            {!data.unavailable.includes('owner') ? (
              <p className="kb-text kb-text--body">
                {data.goal ||
                  uxText('chronos_workspace_no_goal_is_configured_for_this_scope_yet', locale)}
              </p>
            ) : null}
            <nav
              className="flex flex-wrap gap-3"
              aria-label={uxText('chronos_workspace_workspace_navigation', locale)}
            >
              {data.links?.conversation ? (
                <a className="kb-link" href={data.links.conversation}>
                  {uxText('chronos_workspace_discuss_goal', locale)}
                </a>
              ) : null}
              <a
                className="kb-link"
                href={
                  workspaceSectionHref(
                    data.selection.operation_id ? 'home' : 'work-items',
                    data.selection
                  ) + (data.selection.operation_id ? '#workspace-work' : '')
                }
              >
                {uxText('chronos_workspace_work_and_progress', locale)}
              </a>
              <a
                className="kb-link"
                href={
                  workspaceSectionHref(
                    data.selection.operation_id ? 'home' : 'deliverables',
                    data.selection
                  ) + (data.selection.operation_id ? '#workspace-library' : '')
                }
              >
                {uxText('chronos_workspace_resources', locale)}
              </a>
              <a className="kb-link" href={workspaceSectionHref('knowledge', data.selection)}>
                {uxText('chronos_workspace_learning', locale)}
              </a>
              <a className="kb-link" href={workspaceSectionHref('approvals', data.selection)}>
                {uxText('chronos_workspace_decisions', locale)}
              </a>
            </nav>
            <KeyValue
              items={[
                {
                  label: uxText('chronos_workspace_work', locale),
                  value: data.unavailable.includes('work') ? '—' : String(data.work.counts.total),
                },
                {
                  label: uxText('chronos_workspace_active', locale),
                  value: data.unavailable.includes('work') ? '—' : String(data.work.counts.active),
                },
                {
                  label: uxText('chronos_workspace_blocked', locale),
                  value: data.unavailable.includes('work') ? '—' : String(data.work.counts.blocked),
                },
                {
                  label: uxText('chronos_workspace_decisions', locale),
                  value: data.unavailable.includes('decisions')
                    ? '—'
                    : String(data.decisions.approvals.length),
                },
              ]}
            />
            <div id="workspace-work">
              {!data.unavailable.includes('work') ? (
                data.work.items.length ? (
                  <ul>
                    {data.work.items.slice(0, 5).map((item) => (
                      <li key={item.id}>
                        {item.title} · {item.status}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{uxText('chronos_workspace_no_work_in_this_scope_yet', locale)}</p>
                )
              ) : null}
            </div>
            {!data.unavailable.includes('library') ? (
              <div id="workspace-library">
                <h3>{uxText('chronos_workspace_resources', locale)}</h3>
                {data.links?.addResource ? (
                  <a className="kb-link" href={data.links.addResource}>
                    {uxText('chronos_workspace_add_resource', locale)}
                  </a>
                ) : null}
                {data.library.inheritedFrom === 'organization' ? (
                  <p>
                    {uxText(
                      'chronos_workspace_shared_organization_resources_not_exclusive_to_this_operation',
                      locale
                    )}
                  </p>
                ) : null}
                <ul>
                  {data.library.artifacts.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      {item.name} · {item.kind}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <h3>{uxText('chronos_workspace_autonomy', locale)}</h3>
              <p>
                {uxText(
                  'chronos_workspace_pause_prevents_future_wakeups_it_does_not_cancel',
                  locale
                )}
              </p>
              {data.autonomy.dots.map((dot) => (
                <div key={dot.id} className="grid gap-2">
                  <strong>{dot.name}</strong>
                  <p>
                    {dot.goal} · {dot.status}
                  </p>
                  {dot.budget ? (
                    <p>
                      {uxText(
                        'chronos_workspace_shared_budget_usage_not_an_allocation_for_this',
                        locale
                      )}
                      : {dot.budget.scope} · {dot.budget.tokens} tokens · $
                      {dot.budget.costStatus === 'unknown' ? '?' : dot.budget.costUsd}
                      {dot.budget.costStatus === 'partial'
                        ? uxText('chronos_workspace_partial', locale)
                        : ''}{' '}
                      · {dot.budget.throttle}
                    </p>
                  ) : (
                    <p>
                      {uxText(
                        'chronos_workspace_budget_is_unavailable_in_this_viewing_scope',
                        locale
                      )}
                    </p>
                  )}
                  {dot.readiness.errors.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                  {['active', 'paused', 'draft'].includes(dot.status) ? (
                    <Button
                      label={
                        dot.status === 'draft'
                          ? uxText('chronos_workspace_activate', locale)
                          : dot.status === 'paused'
                            ? uxText('chronos_workspace_resume', locale)
                            : uxText('chronos_workspace_pause', locale)
                      }
                      variant="secondary"
                      disabled={
                        busy ||
                        !data.capabilities.canControlAutonomy ||
                        (dot.status !== 'active' && !dot.readiness.ready)
                      }
                      onClick={() =>
                        void control(
                          dot.id,
                          dot.status === 'draft'
                            ? 'activate'
                            : dot.status === 'paused'
                              ? 'resume'
                              : 'pause'
                        )
                      }
                    />
                  ) : null}
                </div>
              ))}
              {!data.autonomy.dots.length && !data.unavailable.includes('autonomy') ? (
                <p>
                  {uxText(
                    'chronos_workspace_autonomy_is_not_configured_set_the_owner_goal',
                    locale
                  )}
                </p>
              ) : null}
              {data.autonomy.blockedReasons.map((reason) => (
                <Callout key={reason} tone="warning" title={reason} />
              ))}
            </div>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
