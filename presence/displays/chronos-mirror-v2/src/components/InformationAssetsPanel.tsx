'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Badge, Button, Callout } from '@agent/shared-ui';
import { workspaceQuery, workspaceSelectionFromQuery } from '@agent/core/surface/workspace-query';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';
import type { InformationAssetsData } from '../lib/information-assets';

/** Key the visible response to the current selection as well as aborting stale requests. */
export function InformationAssetsPanel() {
  const locale = useChronosLocale();
  const words = {
    title: uxText('chronos_information_assets_title', locale),
    description: uxText('chronos_information_assets_description', locale),
    unavailable: uxText('chronos_information_assets_unavailable', locale),
    loading: uxText('chronos_information_assets_loading', locale),
    empty: uxText('chronos_information_assets_empty', locale),
    enabled: uxText('chronos_information_assets_enabled', locale),
    disabled: uxText('chronos_information_assets_disabled', locale),
    authoritative: uxText('chronos_information_assets_authoritative', locale),
    secondary: uxText('chronos_information_assets_secondary', locale),
    freshness: uxText('chronos_information_assets_freshness', locale),
  };
  const t = (key: keyof typeof words) => words[key];
  const query = workspaceQuery(
    workspaceSelectionFromQuery(new URLSearchParams(useSearchParams().toString()))
  ).toString();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{
    key: string;
    data?: InformationAssetsData;
    failed?: boolean;
  }>();
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch('/api/information-assets?' + query, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== 'object' ||
          !('ok' in value) ||
          value.ok !== true ||
          !('locations' in value) ||
          !Array.isArray(value.locations)
        )
          throw new Error('invalid response');
        setResult({ key: query, data: value as InformationAssetsData });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key: query, failed: true });
      });
    return () => controller.abort();
  }, [open, query]);
  const current = result?.key === query ? result : undefined;
  return (
    <div className="space-y-3">
      <Button label={t('title')} variant="secondary" onClick={() => setOpen((value) => !value)} />
      {open && (
        <div>
          <p>{t('description')}</p>
          {current?.failed ? (
            <Callout tone="warning" title={t('unavailable')} />
          ) : !current?.data ? (
            <p>{t('loading')}</p>
          ) : current.data.locations.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <ul>
              {current.data.locations.map((location) => (
                <li key={location.id}>
                  <details>
                    <summary>
                      {location.title} · {location.serviceId}{' '}
                      <Badge label={location.enabled ? t('enabled') : t('disabled')} />
                    </summary>
                    <p>
                      {location.id} · {location.authoritative ? t('authoritative') : t('secondary')}
                    </p>
                    <p>
                      {t('freshness')}: {location.freshnessSeconds}s
                    </p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
