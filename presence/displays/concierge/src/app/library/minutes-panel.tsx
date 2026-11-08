'use client';

import { opsApiPath } from '../../lib/ops/ops-api-path';

import * as React from 'react';
import { Badge, Callout, Disclosure, EmptyState, Section, Skeleton } from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { WsPreformatted, WsSelectTable, WsTitleCell } from '../../components/ops/ChronosWsParts';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import type { ConciergeMessageKey } from '../../lib/i18n';
import { useShellScope } from '../../lib/shell-scope';
import {
  parseMinutesContentResponse,
  parseMinutesResponse,
  type ClientMinutesContent,
  type ClientMinutesItem,
  type ClientMinutesSource,
} from '../../lib/ops/minutes-response';

/**
 * `/library?tab=minutes` — the scoped meeting-minutes index (mission evidence,
 * local-pad records, notepad sessions). The list carries the shell's scope as
 * a *narrowing hint only* — the API resolves the viewer's allowed scope on
 * every request and the content route re-checks it per item.
 */

const SOURCE_KEYS: Record<ClientMinutesSource, ConciergeMessageKey> = {
  mission: 'minutes_source_mission',
  pad: 'minutes_source_pad',
  notepad: 'minutes_source_notepad',
};

function formatWhen(iso: string | undefined, locale: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(localeToBcp47(locale), { dateStyle: 'short', timeStyle: 'short' });
}

export function MinutesPanel() {
  const { t, locale } = useConciergeI18n();
  const scope = useShellScope();
  const [items, setItems] = React.useState<ClientMinutesItem[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<ClientMinutesContent | null>(null);
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentFailed, setContentFailed] = React.useState(false);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (scope.tenant) params.set('tenant', scope.tenant);
    if (scope.organizationId) params.set('organization_id', scope.organizationId);
    if (scope.projectId) params.set('project_id', scope.projectId);
    const text = params.toString();
    return text ? `?${text}` : '';
  }, [scope.tenant, scope.organizationId, scope.projectId]);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setItems(null);
    setSelectedId(null);
    setContent(null);
    fetch(opsApiPath(`/minutes${query}`), { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        const parsed = parseMinutesResponse(body);
        if (!parsed) {
          setLoadFailed(true);
          setLoading(false);
          return;
        }
        setItems(parsed.minutes);
        setLoadFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (live) {
          setLoadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [query]);

  React.useEffect(() => {
    if (!selectedId) {
      setContent(null);
      return;
    }
    let live = true;
    setContentLoading(true);
    setContentFailed(false);
    fetch(opsApiPath(`/minutes/content?id=${encodeURIComponent(selectedId)}`), {
      cache: 'no-store',
    })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        const parsed = parseMinutesContentResponse(body);
        if (!parsed) {
          setContentFailed(true);
          setContentLoading(false);
          return;
        }
        setContent(parsed);
        setContentLoading(false);
      })
      .catch(() => {
        if (live) {
          setContentFailed(true);
          setContentLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  const select = (id: string) => setSelectedId((current) => (current === id ? current : id));

  return (
    <>
      {loadFailed ? <Callout tone="danger" title={t('minutes_load_error')} /> : null}
      <Section title={t('minutes_title')}>
        {loading ? (
          <Skeleton shape="table" label={t('minutes_loading')} />
        ) : !items?.length ? (
          <EmptyState title={t('minutes_empty')} />
        ) : (
          <WsSelectTable<ClientMinutesItem>
            columns={[
              { key: 'item', label: t('minutes_title') },
              { key: 'updated', label: t('minutes_col_updated'), width: '10rem' },
            ]}
            rows={items}
            rowKey={(item) => item.id}
            selectedKey={selectedId}
            onSelect={select}
            empty={t('minutes_empty')}
            renderCell={(item, columnKey, selectItem) =>
              columnKey === 'item' ? (
                <div className="chronos-mission-cell">
                  <WsTitleCell
                    title={item.title}
                    id={[item.missionId, item.tenantSlug].filter(Boolean).join(' · ') || item.key}
                    onSelect={selectItem}
                    selected={item.id === selectedId}
                  />
                  <span className="chronos-meta">
                    <Badge label={t(SOURCE_KEYS[item.source])} tone="neutral" />
                    {item.tier ? ` ${item.tier}` : ''}
                    {item.summary ? ` — ${item.summary}` : ''}
                  </span>
                </div>
              ) : (
                <span className="chronos-meta">
                  {formatWhen(item.updatedAt ?? item.createdAt, locale)}
                </span>
              )
            }
          />
        )}
      </Section>
      {selectedId ? (
        <Section
          title={content?.title ?? t('minutes_preview')}
          actions={[{ label: t('minutes_close'), onClick: () => setSelectedId(null) }]}
        >
          {contentLoading ? (
            <Skeleton lines={6} label={t('minutes_loading')} />
          ) : contentFailed ? (
            <Callout tone="danger" title={t('minutes_load_error')} />
          ) : content ? (
            <>
              <WsPreformatted text={content.content} title={t('minutes_preview')} />
              {content.attachments?.length ? (
                <Section title={t('minutes_attachments')} headingLevel={3}>
                  {content.attachments.map((attachment, index) => (
                    <Disclosure key={`${attachment.label}-${index}`} summary={attachment.label}>
                      <WsPreformatted text={attachment.content} />
                    </Disclosure>
                  ))}
                </Section>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}
