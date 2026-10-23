'use client';

import * as React from 'react';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import type { SettingsTranslate } from './form-scope';

type ServiceEntry = {
  id: string;
  auth_strategy: string;
  oauth: boolean;
  credential_suffixes: string[];
  setup_command: string;
};

export function ServiceCatalogPane({ t }: { t: SettingsTranslate }) {
  const [services, setServices] = React.useState<ServiceEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void fetch('/api/service-catalog')
      .then((res) => res.json())
      .then((body) =>
        body.ok !== false ? setServices(body.services) : setError(body.error ?? 'error')
      )
      .catch(() => setError('error'));
  }, []);

  return (
    <section className="pane" aria-label={t('services.catalog_title')}>
      <h3>{t('services.catalog_title')}</h3>
      <p>{t('services.catalog_hint')}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!services ? null : services.length === 0 ? (
        <p>{t('services.catalog_empty')}</p>
      ) : (
        <ul>
          {services.map((s) => (
            <li key={s.id}>
              <code>{s.id}</code> — {s.auth_strategy}
              {s.credential_suffixes.length > 0 ? ` · ${s.credential_suffixes.join(', ')}` : ''}
              {s.oauth ? ` · ${t('services.oauth_available')}` : ''}
              <br />
              <small>
                <code>{s.setup_command}</code>
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
