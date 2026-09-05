'use client';
/* eslint-disable @next/next/no-img-element */

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  Eye,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  XCircle,
} from 'lucide-react';
import { useChronosLocale } from '../lib/hooks';
import { formatChronosDateTime, uxText } from '../lib/ux-vocabulary';
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

function reviewLabel(verdict: string | undefined, locale: string): string {
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
          setPreview(`Preview error: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

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

  return (
    <section className="kyberion-glass rounded-[30px] border kb-border-subtle p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
            {uxText('chronos_deliverables', locale)}
          </div>
          <h2 className="mt-1 text-xl font-semibold kb-text-primary">
            {uxText('chronos_deliverables_preview_title', locale)}
          </h2>
          <p className="mt-2 text-sm leading-6 kb-text-secondary">
            {uxText('chronos_deliverables_description', locale)}
          </p>
        </div>
        <span className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[10px] kb-text-accent">
          {tenant || uxText('chronos_ac_scope_all', locale)} · {items.length}
        </span>
      </div>
      {error ? (
        <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface p-3 text-[11px] kb-status-negative">
          {error}
        </div>
      ) : null}
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.5fr)]">
        <div className="chronos-scroll max-h-[calc(100vh-18rem)] space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <div className="rounded-xl border kb-border-subtle p-4 text-[11px] kb-text-muted">
              {uxText('chronos_loading', locale)}…
            </div>
          ) : null}
          {!loading && items.length === 0 ? (
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken p-4 text-[11px] kb-text-muted">
              <div>{uxText('chronos_deliverables_empty', locale)}</div>
              {tenant ? (
                <>
                  <div className="mt-2 leading-5">
                    {uxText('chronos_deliverables_empty_tenant_hint', locale)}
                  </div>
                  <a
                    href={(() => {
                      const params = new URLSearchParams(searchParams.toString());
                      params.delete('tenant');
                      params.set('section', 'deliverables');
                      return `${pathname}${params.size ? `?${params.toString()}` : ''}`;
                    })()}
                    className="mt-3 rounded-lg border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] font-semibold kb-text-accent"
                  >
                    {uxText('chronos_deliverables_show_all', locale)}
                  </a>
                </>
              ) : null}
            </div>
          ) : null}
          {items.map((item) => (
            <button
              key={item.artifactId}
              type="button"
              aria-pressed={selected?.artifactId === item.artifactId}
              onClick={() => setSelectedId(item.artifactId)}
              className={`w-full rounded-xl border p-3 text-left transition ${selected?.artifactId === item.artifactId ? 'kb-border-accent kb-surface-accent' : 'kb-border-subtle kb-surface-sunken hover:kb-surface-raised'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold kb-text-primary">{item.kind}</span>
                <span className="text-[9px] kb-text-muted">
                  {reviewLabel(item.reviewVerdict, locale)}
                </span>
              </div>
              <div className="mt-2 truncate text-[10px] kb-text-secondary">
                {item.tenantSlug || uxText('chronos_org_not_configured', locale)} /{' '}
                {item.projectId || uxText('chronos_org_not_configured', locale)}
              </div>
              <div className="mt-1 truncate text-[10px] kb-text-muted">
                {item.path || item.externalRef || item.artifactId}
              </div>
            </button>
          ))}
        </div>
        {selected ? (
          <div className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                  <Eye size={13} /> {uxText('chronos_preview_review', locale)}
                </div>
                <h3 className="mt-1 text-lg font-semibold kb-text-primary">{selected.kind}</h3>
                <p className="mt-1 break-all text-[10px] kb-text-muted">
                  {selected.path || selected.externalRef || selected.artifactId}
                </p>
              </div>
              <span className="rounded-full border kb-border-subtle px-2 py-1 text-[10px] kb-text-secondary">
                {reviewLabel(selected.reviewVerdict, locale)}
              </span>
            </div>
            <div className="mt-4 grid gap-2 text-[10px] sm:grid-cols-3">
              <div>
                <span className="kb-text-muted">{uxText('chronos_tenant', locale)}</span>
                <div className="kb-text-primary">{selected.tenantSlug || '-'}</div>
              </div>
              <div>
                <span className="kb-text-muted">{uxText('chronos_project_mission', locale)}</span>
                <div className="kb-text-primary">
                  {selected.projectId || '-'} /{' '}
                  {selected.missionId && onOpenMission ? (
                    <button
                      type="button"
                      onClick={() => onOpenMission(selected.missionId!)}
                      className="font-mono kb-text-accent hover:underline"
                    >
                      {selected.missionId}
                    </button>
                  ) : (
                    selected.missionId || '-'
                  )}
                </div>
              </div>
              <div>
                <span className="kb-text-muted">{uxText('chronos_updated', locale)}</span>
                <div className="kb-text-primary">
                  {formatChronosDateTime(selected.updatedAt, locale)}
                </div>
              </div>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border kb-border-subtle kb-surface-raised">
              {selected.missing ? (
                <div className="p-5 text-[11px] kb-status-negative">
                  {uxText('chronos_deliverable_missing', locale)}
                </div>
              ) : isTextAsset(selected) || selected.previewText ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap p-4 text-[11px] leading-5 kb-text-secondary">
                  {preview ?? selected.previewText ?? uxText('chronos_no_inline_preview', locale)}
                </pre>
              ) : isImageAsset(selected) && assetUrl(selected) ? (
                <img
                  src={assetUrl(selected) || ''}
                  alt={selected.kind}
                  className="max-h-[28rem] w-full object-contain"
                />
              ) : isPdfAsset(selected) && assetUrl(selected) ? (
                <iframe
                  title={`${selected.kind} preview`}
                  src={assetUrl(selected) || ''}
                  className="h-[28rem] w-full bg-white"
                />
              ) : selected.previewText ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap p-4 text-[11px] leading-5 kb-text-secondary">
                  {selected.previewText}
                </pre>
              ) : (
                <div className="p-5 text-[11px] kb-text-muted">
                  <FileText size={16} className="mb-2" />
                  {uxText('chronos_no_inline_preview', locale)}
                </div>
              )}
            </div>
            {assetUrl(selected) ? (
              <a
                href={assetUrl(selected) || '#'}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[10px] kb-text-accent hover:underline"
              >
                <ImageIcon size={12} />
                {uxText('chronos_open_new_window', locale)}
              </a>
            ) : null}
            <textarea
              aria-label="Review comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={uxText('chronos_review_comment', locale)}
              className="mt-4 min-h-20 w-full rounded-xl border kb-border-subtle kb-surface-raised p-3 text-xs kb-text-primary outline-none"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || selected.missing || accessRole !== 'localadmin'}
                onClick={() => void review('accept')}
                className="inline-flex items-center gap-1 rounded-lg kb-surface-positive px-3 py-2 text-[11px] kb-status-positive disabled:opacity-50"
              >
                <CheckCircle2 size={14} />
                {uxText('chronos_approve', locale)}
              </button>
              <button
                type="button"
                disabled={busy || selected.missing || accessRole !== 'localadmin'}
                onClick={() => void review('request-changes')}
                className="inline-flex items-center gap-1 rounded-lg kb-surface-accent px-3 py-2 text-[11px] kb-text-accent disabled:opacity-50"
              >
                <MessageSquare size={14} />
                {uxText('chronos_request_changes', locale)}
              </button>
              <button
                type="button"
                disabled={busy || selected.missing || accessRole !== 'localadmin'}
                onClick={() => void review('reject')}
                className="inline-flex items-center gap-1 rounded-lg kb-surface-negative px-3 py-2 text-[11px] kb-status-negative disabled:opacity-50"
              >
                <XCircle size={14} />
                {uxText('chronos_reject', locale)}
              </button>
            </div>
            {accessRole !== 'localadmin' ? (
              <div className="mt-3 text-[10px] kb-text-muted">
                {uxText('chronos_localadmin_required', locale)}
              </div>
            ) : null}
            {selected.reviewComment ? (
              <div className="mt-3 rounded-lg border kb-border-subtle p-3 text-[11px] kb-text-secondary">
                {uxText('chronos_previous_note', locale)}: {selected.reviewComment}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-2xl border kb-border-subtle p-6 text-sm kb-text-muted">
            {uxText('chronos_select_deliverable', locale)}
          </div>
        )}
      </div>
    </section>
  );
}
