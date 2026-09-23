'use client';

import * as React from 'react';
import { Button, Callout, IntegrationItem, SettingsGroup, Switch } from '@agent/shared-ui';
import type { KbActionRef } from '@agent/core/a2ui-catalog';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type { Setup } from '../../../lib/settings-types';
import { IntroduceSecretPanel } from './IntroduceSecretPanel';
import { FormScope, type SettingsTranslate } from './form-scope';

/** FD-06 サービス連携 pane (`#setup-services`) — extracted from
 * settings/page.tsx; OAuth connect + save-connections handlers stay owned
 * by the page and are passed in as props. UI-06: one `IntegrationItem` per
 * service (real `configured` state + the OAuth connect action) with a
 * `Switch` for whether it is part of the onboarding draft, then the
 * governed API-token panel. */
export type ServicesSectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
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
  const fields = Object.fromEntries(
    setup.service_catalog.map((service) => [
      `service.use.${service.id}`,
      (value: unknown) =>
        setServices((current) =>
          value === true
            ? current.includes(service.id)
              ? current
              : [...current, service.id]
            : current.filter((id) => id !== service.id)
        ),
    ])
  );
  return (
    <div
      className="settings-section"
      id="setup-services"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_services', locale)}
    >
      <FormScope
        fields={fields}
        actions={{
          'service.connect': (payload) =>
            onConnectOAuth(String(payload.service_id ?? ''), String(payload.label ?? '')),
        }}
      >
        <SettingsGroup
          id="settings-services"
          title={frontDeskText('settings_nav_services', locale)}
          description={frontDeskText('settings_services_lead', locale)}
        >
          <div className="settings-row-block">
            <p className="kb-text kb-text--body">{t('setup.services_title')}</p>
            <p className="kb-text kb-text--muted">{t('setup.services_description')}</p>
            <p className="kb-text kb-text--caption">{t('setup.connect_oauth_hint')}</p>
          </div>
          <div className="settings-row-block settings-integration-list">
            {setup.service_catalog.map((service) => {
              const oauthCapable = /oauth/i.test(service.auth);
              const actions: KbActionRef[] = oauthCapable
                ? [
                    {
                      label: oauthBusyId === service.id ? '…' : t('setup.connect_oauth'),
                      variant: service.configured ? 'ghost' : 'secondary',
                      disabled: busy || oauthBusyId === service.id,
                      action: {
                        id: 'service.connect',
                        payload: { service_id: service.id, label: service.label },
                      },
                    },
                  ]
                : [];
              return (
                <div className="settings-integration" key={service.id} data-service={service.id}>
                  <IntegrationItem
                    id={`service-${service.id}`}
                    title={service.label}
                    state={service.configured ? 'connected' : 'disconnected'}
                    detail={service.auth}
                    icon="plug"
                    actions={actions}
                  />
                  <Switch
                    id={`service-use-${service.id}`}
                    name={`service.use.${service.id}`}
                    label={t('settings.service_use')}
                    value={services.includes(service.id)}
                    disabled={busy}
                  />
                </div>
              );
            })}
          </div>
          {oauthMessage ? (
            <div className="settings-row-block">
              <Callout tone="info" title={oauthMessage} />
            </div>
          ) : null}
          <div className="settings-row-actions">
            <Button
              label={t('setup.save_connections')}
              variant="primary"
              disabled={busy}
              onClick={onSaveConnections}
            />
          </div>
        </SettingsGroup>
      </FormScope>
      <IntroduceSecretPanel
        t={t}
        busy={busy}
        services={setup.service_catalog.map((service) => ({
          id: service.id,
          label: service.label,
        }))}
      />
    </div>
  );
}
