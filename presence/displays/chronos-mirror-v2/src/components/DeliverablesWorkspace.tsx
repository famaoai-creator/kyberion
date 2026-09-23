'use client';
/* eslint-disable @next/next/no-img-element */

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  KeyValue,
  Section,
  Skeleton,
  StatusPill,
} from '@agent/shared-ui';
import { WsPreformatted, WsSelectTable, WsTextareaField, WsTitleCell } from './ChronosWsParts';
import { useChronosLocale } from '../lib/hooks';
import {
  formatChronosDateTime,
  uxMessage,
  uxText,
  uxTextOr,
  type SupportedLocale,
} from '../lib/ux-vocabulary';
import {
  parseDeliverablesResponse,
  type ClientDeliverable as Deliverable,
} from '../lib/deliverables-response';

function assetUrl(item: Deliverable): string | null {
  if (item.externalRef && /^https?:\/\//i.test(item.externalRef)) return item.externalRef;
  if (!item.path) {
    if (!item.previewText) return null;
    const params = new URLSearchParams({ artifactId: item.artifactId });
    if (item.tenantSlug) params.set('tenant', item.tenantSlug);
    return `/api/deliverable-preview?${params.toString()}`;
  }
  const params = new URLSearchParams({ path: item.path });
  params.set('artifactId', item.artifactId);
  if (item.tenantSlug) params.set('tenant', item.tenantSlug);
  if (!item.path.startsWith('active/') && item.missionId) params.set('missionId', item.missionId);
  return `/api/mission-asset?${params.toString()}`;
}

function extension(item: Deliverable): string {
  return (item.path || item.externalRef || '').split('?')[0].split('.').pop()?.toLowerCase() || '';
}

function isTextAsset(item: Deliverable): boolean {
  return [
    'md',
    'markdown',
    'txt',
    'json',
    'csv',
    'log',
    'html',
    'htm',
    'xml',
    'yaml',
    'yml',
  ].includes(extension(item));
}

function isImageAsset(item: Deliverable): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension(item));
}

function isPdfAsset(item: Deliverable): boolean {
  return extension(item) === 'pdf';
}

function reviewLabel(verdict: string | undefined, locale: SupportedLocale): string {
  if (!verdict) return uxText('chronos_not_reviewed', locale);
  if (verdict === 'accept') return uxText('chronos_approve', locale);
  if (verdict === 'request-changes') return uxText('chronos_request_changes', locale);
  if (verdict === 'reject') return uxText('chronos_reject', locale);
  return verdict;
}

export function DeliverablesWorkspace({
  tenant,
  organizationId,
  projectId,
  onOpenMission,
}: {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
  onOpenMission?: (missionId: string) => void;
}) {
  const locale = useChronosLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [items, setItems] = React.useState<Deliverable[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState('');
  const selected = items.find((item) => item.artifactId === selectedId) || items[0] || null;

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (tenant) query.set('tenant', tenant);
      if (organizationId) query.set('organization_id', organizationId);
      if (projectId) query.set('project_id', projectId);
      const response = await fetch(`/api/deliverables?${query.toString()}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      const parsed = parseDeliverablesResponse(payload);
      if (!response.ok || !parsed) throw new Error('Invalid deliverables response');
      const nextItems = parsed.deliverables;
      setAccessRole(parsed.accessRole);
      setItems(nextItems);
      setSelectedId((current) =>
        nextItems.some((item: Deliverable) => item.artifactId === current)
          ? current
          : nextItems[0]?.artifactId || null
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenant, organizationId, projectId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    setPreview(null);
    if (!selected) return;
    const url = assetUrl(selected);
    if (!url) {
      if (selected.previewText) setPreview(selected.previewText);
      return;
    }
    let cancelled = false;
    void fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load the preview');
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setPreview(text);
      })
      .catch((err) => {
        if (!cancelled)
          setPreview(
            `${uxTextOr('chronos_ws_preview_error', 'Preview error', locale)}: ${err instanceof Error ? err.message : String(err)}`
          );
      });
    return () => {
      cancelled = true;
    };
  }, [selected, locale]);

  const review = async (verdict: 'accept' | 'request-changes' | 'reject') => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/deliverable-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId: selected.artifactId, verdict, comment, tenant }),
      });
      if (!response.ok) throw new Error('Failed to review the deliverable');
      setComment('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const localAdmin = accessRole === 'localadmin';
  const scopeLabel = `${tenant || uxText('chronos_ac_scope_all', locale)} · ${items.length}`;
  const showAllHref = (() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('tenant');
    params.set('section', 'deliverables');
    return `${pathname}${params.size ? `?${params.toString()}` : ''}`;
  })();
  const selectedUrl = selected ? assetUrl(selected) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
      <Section
        title={uxText('chronos_deliverables_preview_title', locale)}
        description={uxText('chronos_deliverables_description', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge label={scopeLabel} tone="accent" />
        </div>
        {error ? (
          <Callout
            tone="danger"
            title={uxTextOr('chronos_ws_load_failed', 'Could not load this view', locale)}
            body={error}
          />
        ) : null}
        {loading && items.length === 0 ? (
          <Skeleton shape="table" lines={4} label={uxText('chronos_loading', locale)} />
        ) : items.length === 0 ? (
          <EmptyState
            title={uxText('chronos_deliverables_empty', locale)}
            body={tenant ? uxText('chronos_deliverables_empty_tenant_hint', locale) : undefined}
            action={
              tenant
                ? { label: uxText('chronos_deliverables_show_all', locale), href: showAllHref }
                : undefined
            }
          />
        ) : (
          <WsSelectTable
            columns={[
              { key: 'kind', label: uxTextOr('chronos_ws_col_deliverable', 'Deliverable', locale) },
              { key: 'review', label: uxText('chronos_col_status', locale), width: '8rem' },
            ]}
            rows={items}
            rowKey={(item) => item.artifactId}
            selectedKey={selected?.artifactId}
            onSelect={setSelectedId}
            empty={uxText('chronos_deliverables_empty', locale)}
            renderCell={(item, key, select) =>
              key === 'kind' ? (
                <div className="flex flex-col gap-0.5">
                  <WsTitleCell
                    title={item.kind}
                    id={item.path || item.externalRef || item.artifactId}
                    onSelect={select}
                    selected={selected?.artifactId === item.artifactId}
                  />
                  <span className="kb-list__meta">
                    {item.tenantSlug || uxText('chronos_org_not_configured', locale)} /{' '}
                    {item.projectId || uxText('chronos_org_not_configured', locale)}
                  </span>
                </div>
              ) : (
                <StatusPill
                  status={reviewStatus(item.reviewVerdict)}
                  label={reviewLabel(item.reviewVerdict, locale)}
                />
              )
            }
          />
        )}
      </Section>

      {selected ? (
        <Section title={selected.kind} description={uxText('chronos_preview_review', locale)}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              status={reviewStatus(selected.reviewVerdict)}
              label={reviewLabel(selected.reviewVerdict, locale)}
            />
            <span className="chronos-mission-cell__id">
              {selected.path || selected.externalRef || selected.artifactId}
            </span>
          </div>
          <dl className="kb-kv">
            <dt className="kb-kv__label">{uxText('chronos_tenant', locale)}</dt>
            <dd className="kb-kv__value" data-mono="true">
              {selected.tenantSlug || '-'}
            </dd>
            <dt className="kb-kv__label">{uxText('chronos_project_mission', locale)}</dt>
            <dd className="kb-kv__value" data-mono="true">
              {selected.projectId || '-'} /{' '}
              {selected.missionId && onOpenMission ? (
                <button
                  type="button"
                  className="chronos-mission-cell__title"
                  onClick={() => onOpenMission(selected.missionId!)}
                >
                  {selected.missionId}
                </button>
              ) : (
                selected.missionId || '-'
              )}
            </dd>
            <dt className="kb-kv__label">{uxText('chronos_updated', locale)}</dt>
            <dd className="kb-kv__value">{formatChronosDateTime(selected.updatedAt, locale)}</dd>
          </dl>
          {selected.missing ? (
            <Callout tone="danger" title={uxText('chronos_deliverable_missing', locale)} />
          ) : isTextAsset(selected) || selected.previewText ? (
            <WsPreformatted
              text={preview ?? selected.previewText ?? uxText('chronos_no_inline_preview', locale)}
            />
          ) : isImageAsset(selected) && selectedUrl ? (
            <img
              src={selectedUrl}
              alt={selected.kind}
              className="max-h-[28rem] w-full object-contain"
            />
          ) : isPdfAsset(selected) && selectedUrl ? (
            <iframe
              title={uxMessage(
                'chronos_ws_preview_frame_title',
                { kind: selected.kind },
                '{kind} preview',
                locale
              )}
              src={selectedUrl}
              className="h-[28rem] w-full"
              style={{
                border: '1px solid var(--kb-ui-border)',
                borderRadius: 'var(--kb-ui-radius-md)',
              }}
            />
          ) : (
            <EmptyState title={uxText('chronos_no_inline_preview', locale)} />
          )}
          {selectedUrl ? (
            <div>
              <a
                href={selectedUrl}
                target="_blank"
                rel="noreferrer"
                className="kb-btn kb-btn--ghost"
              >
                {uxText('chronos_open_new_window', locale)}
              </a>
            </div>
          ) : null}
          {selected.reviewComment ? (
            <KeyValue
              items={[
                { label: uxText('chronos_previous_note', locale), value: selected.reviewComment },
              ]}
            />
          ) : null}
          <WsTextareaField
            id="chronos-deliverable-comment"
            label={uxTextOr('chronos_ws_review_comment_label', 'Review comment', locale)}
            value={comment}
            onChange={setComment}
            placeholder={uxText('chronos_review_comment', locale)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              label={uxText('chronos_approve', locale)}
              variant="primary"
              disabled={busy || selected.missing || !localAdmin}
              onClick={() => void review('accept')}
            />
            <Button
              label={uxText('chronos_request_changes', locale)}
              variant="secondary"
              disabled={busy || selected.missing || !localAdmin}
              onClick={() => void review('request-changes')}
            />
            <Button
              label={uxText('chronos_reject', locale)}
              variant="danger"
              disabled={busy || selected.missing || !localAdmin}
              onClick={() => void review('reject')}
            />
          </div>
          {!localAdmin ? (
            <p className="kb-text kb-text--muted">
              {uxText('chronos_localadmin_required', locale)}
            </p>
          ) : null}
        </Section>
      ) : loading ? null : (
        <Section>
          <EmptyState title={uxText('chronos_select_deliverable', locale)} />
        </Section>
      )}
    </div>
  );
}

function reviewStatus(verdict: string | undefined): KbStatus {
  if (!verdict) return 'pending';
  if (verdict === 'accept') return 'completed';
  if (verdict === 'request-changes') return 'needs_clarification';
  if (verdict === 'reject') return 'failed';
  return 'n/a';
}
