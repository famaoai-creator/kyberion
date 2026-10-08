'use client';

import * as React from 'react';
import { Badge, Button, SettingsGroup, Switch } from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import type { Setup } from '../../../lib/settings-types';
import { groupConnections, type ConnectionViewItem } from '../../../lib/connection-view';
import { OperatorServiceRegistrationPanel } from './OperatorServiceRegistrationPanel';
import { FormScope, type SettingsTranslate } from './form-scope';

/** Service selections are metadata. Token registration and authentication are separate actions. */
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
      <FormScope fields={fields}>
        <SettingsGroup
          id="settings-services"
          title={frontDeskText('settings_nav_services', locale)}
          description={t('settings.operator_selections_description')}
        >
          <div className="settings-row-block">
            <p className="kb-text kb-text--body">{t('settings.operator_selections_title')}</p>
          </div>
          <div className="settings-row-block settings-integration-list">
            {setup.service_catalog.map((service) => {
              return (
                <div className="settings-integration" key={service.id} data-service={service.id}>
                  <div className="kb-setting-row__text">
                    <p className="kb-text kb-text--body">{service.label}</p>
                    <Badge
                      label={t(
                        service.configured
                          ? 'settings.operator_metadata_configured'
                          : 'settings.operator_metadata_unconfigured'
                      )}
                      tone="neutral"
                    />
                  </div>
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
          {(setup.connections ?? []).length > 0 ? <ConnectionsByOwner t={t} setup={setup} /> : null}
          <div className="settings-row-actions">
            <Button
              label={t('settings.operator_save_selections')}
              variant="primary"
              disabled={busy}
              onClick={onSaveConnections}
            />
          </div>
        </SettingsGroup>
      </FormScope>
      <OperatorServiceRegistrationPanel t={t} />
    </div>
  );
}

/** Connections by owner: "yours" first, then one block per organization, each with an owner badge. */
function ConnectionsByOwner({ t, setup }: { t: SettingsTranslate; setup: Setup }) {
  const grouped = groupConnections((setup.connections ?? []) as ConnectionViewItem[]);
  const label = (serviceId: string) =>
    setup.service_catalog.find((service) => service.id === serviceId)?.label ?? serviceId;
  const rows = (items: ConnectionViewItem[]) =>
    items.map((item) => (
      <p key={item.binding_id} className="kb-text kb-text--body">
        {label(item.service_id)}{' '}
        <Badge
          label={
            item.group === 'organization'
              ? t('setup.connection_owner_organization', { tenant: item.owner_ref ?? '' })
              : t('setup.connection_owner_person')
          }
          tone={item.group === 'organization' ? 'info' : 'neutral'}
        />{' '}
        {item.readiness === 'needs_credential' ? (
          <Badge label={t('setup.connection_needs_credential')} tone="warning" />
        ) : null}
      </p>
    ));
  return (
    <>
      {grouped.mine.length > 0 ? (
        <div className="settings-row-block">
          <h4>{t('setup.connections_mine')}</h4>
          {rows(grouped.mine)}
        </div>
      ) : null}
      {grouped.organizations.map((group) => (
        <div className="settings-row-block" key={group.tenant_slug}>
          <h4>{t('setup.connections_organization', { tenant: group.tenant_slug })}</h4>
          {rows(group.items)}
        </div>
      ))}
    </>
  );
}
