'use client';

import * as React from 'react';
import { Badge, Button } from '@agent/shared-ui';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import type { SettingsTranslate } from './form-scope';

type ServiceEntry = {
  id: string;
  auth_strategy: string;
  oauth: boolean;
  credential_suffixes: string[];
  setup_command: string;
};

type ServiceCatalogPaneProps = {
  t: SettingsTranslate;
  onConnectOAuth?: (serviceId: string, serviceLabel: string) => void;
  busy?: boolean;
  oauthBusyId?: string | null;
  oauthMessage?: string | null;
  oauthError?: boolean;
};

export function ServiceCatalogPane({
  t,
  onConnectOAuth,
  busy = false,
  oauthBusyId = null,
  oauthMessage,
  oauthError = false,
}: ServiceCatalogPaneProps) {
  const [services, setServices] = React.useState<ServiceEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [authFilter, setAuthFilter] = React.useState('all');

  React.useEffect(() => {
    const controller = new AbortController();
    setServices(null);
    setFailed(false);
    void fetch('/api/service-catalog', { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('catalog unavailable');
        return parseServices(await res.json());
      })
      .then((entries) => {
        if (!controller.signal.aborted) setServices(entries);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [revision]);

  const search = query.trim().toLocaleLowerCase();
  const visible = (services ?? []).filter(
    (service) =>
      (!search || service.id.toLocaleLowerCase().includes(search)) &&
      (authFilter === 'all' || (authFilter === 'oauth' ? service.oauth : !service.oauth))
  );

  return (
    <section className="pane" id="service-catalog" aria-label={t('services.catalog_title')}>
      <h3>{t('services.catalog_title')}</h3>
      <p>{t('services.catalog_hint')}</p>
      {oauthBusyId ? <p role="status">{t('authority.connecting')}</p> : null}
      {oauthMessage ? <p role={oauthError ? 'alert' : 'status'}>{oauthMessage}</p> : null}
      <div className="settings-row-block settings-inline-actions">
        <label>
          {t('services.search')}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          {t('services.auth_filter')}
          <select value={authFilter} onChange={(event) => setAuthFilter(event.target.value)}>
            <option value="all">{t('services.filter_all')}</option>
            <option value="oauth">{t('services.filter_oauth')}</option>
            <option value="other">{t('services.filter_other')}</option>
          </select>
        </label>
      </div>
      {failed ? (
        <div className="settings-row-block">
          <p role="alert">{t('services.catalog_failed')}</p>
          <Button label={t('services.retry')} onClick={() => setRevision((value) => value + 1)} />
        </div>
      ) : services === null ? (
        <p role="status">{t('services.catalog_loading')}</p>
      ) : services.length === 0 ? (
        <p role="status">{t('services.catalog_empty')}</p>
      ) : (
        <>
          <p role="status">
            {t('services.result_count', { count: visible.length, total: services.length })}
          </p>
          {visible.length === 0 ? <p>{t('services.no_matches')}</p> : null}
          <div className="settings-integration-list">
            {visible.map((service) => (
              <div
                className="settings-integration"
                key={service.id}
                data-catalog-service={service.id}
              >
                <h4 className="kb-text kb-text--body">{service.id}</h4>
                <Badge
                  label={t(service.oauth ? 'services.oauth_available' : 'services.manual_setup')}
                  tone="neutral"
                />
                <p className="kb-text kb-text--muted">
                  {t(service.oauth ? 'services.oauth_next' : 'services.manual_next')}
                </p>
                {service.oauth && onConnectOAuth ? (
                  <Button
                    label={t('setup.connect_oauth', { service: service.id })}
                    disabled={busy || oauthBusyId !== null}
                    onClick={() => onConnectOAuth(service.id, service.id)}
                  />
                ) : null}
                <details>
                  <summary>{t('services.setup_details')}</summary>
                  <p className="kb-text kb-text--caption">{service.auth_strategy}</p>
                  <p>
                    <code>{service.setup_command}</code>
                  </p>
                </details>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Catalog metadata is not an authentication result; project only expected public fields. */
function parseServices(body: unknown): ServiceEntry[] {
  if (!body || typeof body !== 'object') throw new Error('invalid catalog');
  const record = body as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.services)) throw new Error('invalid catalog');
  return record.services
    .map((value: unknown) => {
      if (!value || typeof value !== 'object') throw new Error('invalid service');
      const service = value as Record<string, unknown>;
      if (
        typeof service.id !== 'string' ||
        !service.id.trim() ||
        typeof service.auth_strategy !== 'string' ||
        typeof service.oauth !== 'boolean' ||
        typeof service.setup_command !== 'string' ||
        !Array.isArray(service.credential_suffixes) ||
        service.credential_suffixes.some((suffix) => typeof suffix !== 'string')
      )
        throw new Error('invalid service');
      return {
        id: service.id,
        auth_strategy: service.auth_strategy,
        oauth: service.oauth,
        credential_suffixes: service.credential_suffixes as string[],
        setup_command: service.setup_command,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
