'use client';

import { useState } from 'react';
import { Button, Disclosure } from '@agent/shared-ui';
import { frontDeskText, type ConciergeLocale } from '../../../lib/i18n';
import { opsApiPath } from '../../../lib/ops/ops-api-path';
import {
  parseAgentProvidersResponse,
  type ClientAgentProvider,
} from '../../../lib/ops/agent-providers-response';
import type { Setup } from '../../../lib/setup-response';
import type { SettingsTenantView } from '../../../lib/settings-types';
import type { SettingsTranslate } from './form-scope';

export function SetupOverview({
  setup,
  viewing,
  locale,
  t,
  onNavigate,
}: {
  setup: Setup;
  viewing: SettingsTenantView | null;
  locale: ConciergeLocale;
  t: SettingsTranslate;
  onNavigate: (target: string) => void;
}) {
  const [providers, setProviders] = useState<ClientAgentProvider[]>();
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const agent = setup.agent_management.configured;
  const label = (key: Parameters<typeof frontDeskText>[0]) => frontDeskText(key, locale);

  async function checkProviders() {
    setLoading(true);
    setUnavailable(false);
    setProviders(undefined);
    try {
      const response = await fetch(opsApiPath('/agents?providers=true'), {
        cache: 'no-store',
      });
      const result = response.ok ? parseAgentProvidersResponse(await response.json()) : undefined;
      setProviders(result?.providers);
      setUnavailable(!result?.providers.length);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Disclosure summary={label('setup_inventory')}>
      <dl>
        <dt>{label('setup_inventory_agent')}</dt>
        <dd>
          {[agent?.display_name || agent?.agent_id, agent?.provider, agent?.model_id]
            .filter(Boolean)
            .join(' · ') || label('setup_inventory_unknown')}
        </dd>
        <dt>{label('setup_inventory_scope')}</dt>
        <dd>
          {viewing ? `${viewing.display_name} · ${viewing.role}` : label('setup_inventory_unknown')}
        </dd>
      </dl>
      <h3>{label('setup_inventory_runtime')}</h3>
      <p className="kb-text kb-text--muted">{label('setup_inventory_auth')}</p>
      <div aria-busy={loading}>
        <Button
          variant="secondary"
          label={label('setup_inventory_probe')}
          disabled={loading}
          onClick={() => void checkProviders()}
        />
        {loading && <p role="status">{t('setup.loading')}</p>}
        {unavailable && <p role="status">{label('setup_inventory_unavailable')}</p>}
        {providers && providers.length > 0 && (
          <ul>
            {providers.map((provider) => (
              <li key={provider.provider}>
                {provider.provider} ·{' '}
                {label(provider.installed ? 'setup_inventory_detected' : 'setup_inventory_missing')}
                {provider.models.length > 0 && ` · ${provider.models.join(', ')}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      <h3>{label('settings_nav_services')}</h3>
      <ul>
        {setup.service_catalog.map((service) => (
          <li key={service.id}>
            {service.label} ·{' '}
            {setup.connections?.some(
              (connection) =>
                connection.service_id === service.id && connection.readiness === 'ready'
            )
              ? label('setup_inventory_connection')
              : label('setup_inventory_unknown')}
          </li>
        ))}
      </ul>
      {setup.capabilities.length > 0 && (
        <>
          <h3>{label('setup_inventory_capabilities')}</h3>
          <ul>
            {setup.capabilities.map((capability) => (
              <li key={capability.id}>{capability.label}</li>
            ))}
          </ul>
        </>
      )}
      <div className="settings-inline-actions">
        <Button
          variant="secondary"
          label={label('settings_nav_services')}
          onClick={() => onNavigate('setup-services')}
        />
        <Button
          variant="secondary"
          label={label('ia_settings_card_reasoning')}
          onClick={() => onNavigate('settings-reasoning')}
        />
        <Button
          variant="secondary"
          label={label('settings_nav_authority')}
          onClick={() => onNavigate('settings-authority')}
        />
      </div>
    </Disclosure>
  );
}
