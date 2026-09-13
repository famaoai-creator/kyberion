'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { Setup } from '../../../lib/settings-types';

/** FD-06 サービス連携 pane (`#setup-services`) — extracted from
 * settings/page.tsx; OAuth connect + save-connections handlers stay owned
 * by the page and are passed in as props. */
export type ServicesSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
  setup: Setup;
  services: string[];
  setServices: React.Dispatch<React.SetStateAction<string[]>>;
  busy: boolean;
  oauthBusyId: string | null;
  oauthMessage: string | null;
  onConnectOAuth: (serviceId: string, serviceLabel: string) => void;
  onSaveConnections: () => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function ServicesSection({
  locale,
  t,
  setup,
  services,
  setServices,
  busy,
  oauthBusyId,
  oauthMessage,
  onConnectOAuth,
  onSaveConnections,
  sectionRef,
}: ServicesSectionProps) {
  return (
    <section
      className="pane"
      id="setup-services"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_services', locale)}
    >
      <h2>{frontDeskText('settings_nav_services', locale)}</h2>
      <p className="settings-card-lead">{frontDeskText('settings_services_lead', locale)}</p>
      <h3 className="pane-subheading">{t('setup.services_title')}</h3>
      <p className="pane-subtitle">{t('setup.services_description')}</p>
      <p className="item-meta">{t('setup.connect_oauth_hint')}</p>
      <div className="service-icon-grid">
        {setup.service_catalog.map((service) => {
          const oauthCapable = /oauth/i.test(service.auth);
          const initial = service.label.slice(0, 1).toUpperCase();
          return (
            <div className="service-tile" key={service.id} data-service={service.id}>
              <div className="service-tile-icon" aria-hidden="true">
                {initial}
              </div>
              <div className="service-tile-body">
                <label className="service-tile-label">
                  <input
                    type="checkbox"
                    checked={services.includes(service.id)}
                    onChange={(event) =>
                      setServices((current) =>
                        event.target.checked
                          ? [...current, service.id]
                          : current.filter((id) => id !== service.id)
                      )
                    }
                  />
                  <span>{service.label}</span>
                </label>
                <span className={`status-chip${service.configured ? '' : ' attention'}`}>
                  {service.configured ? t('setup.connected') : service.auth}
                </span>
                {oauthCapable ? (
                  <button
                    type="button"
                    className="action-button secondary service-connect-btn"
                    disabled={busy || oauthBusyId === service.id}
                    onClick={() => onConnectOAuth(service.id, service.label)}
                  >
                    {oauthBusyId === service.id ? '…' : t('setup.connect_oauth')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {oauthMessage ? <p className="item-meta">{oauthMessage}</p> : null}
      <div className="button-row">
        <button className="action-button" disabled={busy} onClick={onSaveConnections}>
          {t('setup.save_connections')}
        </button>
      </div>
    </section>
  );
}
