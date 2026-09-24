'use client';

import * as React from 'react';
import { Button, EmptyState, SettingRow, SettingsGroup, StatusPill } from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { PluginEntry } from '../../../lib/settings-types';
import type { SettingsTranslate } from './form-scope';

/** FD-06/CS-03 プラグイン pane (`#setup-plugins`) — extracted from
 * settings/page.tsx; the approve/deny decision handler stays owned by the
 * page. UI-06: one `SettingRow` per plugin with a status pill; the inline
 * confirm step (no auto-approval, no browser dialog) is unchanged. */
const PLUGIN_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  activatable: 'setup.plugin_status_activatable',
  pending_approval: 'setup.plugin_status_pending',
  blocked_broken_manifest: 'setup.plugin_status_blocked',
  blocked_digest_mismatch: 'setup.plugin_status_digest_mismatch',
  not_loadable: 'setup.plugin_status_not_loadable',
};

/** Status-pill tone per plugin standing (catalog status vocabulary). */
const PLUGIN_STATUS_PILL: Record<string, KbStatus> = {
  activatable: 'ready',
  pending_approval: 'pending',
  blocked_broken_manifest: 'blocked',
  blocked_digest_mismatch: 'blocked',
  not_loadable: 'unavailable',
};

const PLUGIN_TRUST_KEYS: Record<string, ConciergeMessageKey> = {
  official: 'setup.plugin_trust_official',
  curated: 'setup.plugin_trust_curated',
  'third-party': 'setup.plugin_trust_third_party',
};

export type PluginConfirmState = { id: string; decision: 'approve' | 'deny' } | null;

export type PluginsSectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  plugins: PluginEntry[];
  pluginConfirm: PluginConfirmState;
  setPluginConfirm: (confirm: PluginConfirmState) => void;
  busy: boolean;
  onDecidePlugin: (id: string, decision: 'approve' | 'deny') => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function PluginsSection({
  locale,
  t,
  plugins,
  pluginConfirm,
  setPluginConfirm,
  busy,
  onDecidePlugin,
  sectionRef,
}: PluginsSectionProps) {
  return (
    <div
      className="settings-section"
      id="setup-plugins"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_plugins', locale)}
    >
      <SettingsGroup
        id="settings-plugins"
        title={frontDeskText('settings_nav_plugins', locale)}
        description={`${t('setup.plugins_description')} ${t('setup.plugins_caveat')}`}
      >
        {plugins.length === 0 ? (
          <div className="settings-row-block">
            <EmptyState title={t('setup.plugins_empty')} />
          </div>
        ) : (
          plugins.map((plugin) => {
            const denied = plugin.approval_status === 'rejected';
            const statusKey = denied
              ? 'setup.plugin_status_denied'
              : PLUGIN_STATUS_KEYS[plugin.status];
            const trustKey = PLUGIN_TRUST_KEYS[plugin.trust];
            const decidable = plugin.status === 'pending_approval';
            const confirming = decidable && pluginConfirm?.id === plugin.id;
            const meta = `${trustKey ? t(trustKey) : plugin.trust}${
              plugin.requested_by
                ? ` · ${t('setup.plugin_requested_by', { value: plugin.requested_by })}`
                : ''
            }`;
            return (
              <div className="settings-row-group" key={`${plugin.source}-${plugin.id}`}>
                <SettingRow label={plugin.id} description={meta}>
                  <StatusPill
                    status={denied ? 'blocked' : (PLUGIN_STATUS_PILL[plugin.status] ?? 'n/a')}
                    label={statusKey ? t(statusKey) : plugin.status}
                  />
                </SettingRow>
                {confirming ? (
                  <div className="settings-row-confirm" role="group">
                    <p className="kb-text kb-text--body">
                      {t(
                        pluginConfirm.decision === 'approve'
                          ? 'setup.plugin_confirm_approve'
                          : 'setup.plugin_confirm_deny'
                      )}
                    </p>
                    <div className="settings-inline-actions">
                      <Button
                        label={t('setup.confirm_yes')}
                        variant={pluginConfirm.decision === 'approve' ? 'primary' : 'danger'}
                        disabled={busy}
                        onClick={() => onDecidePlugin(plugin.id, pluginConfirm.decision)}
                      />
                      <Button
                        label={t('setup.confirm_back')}
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setPluginConfirm(null)}
                      />
                    </div>
                  </div>
                ) : decidable ? (
                  <div className="settings-row-actions">
                    <Button
                      label={t('setup.plugin_approve')}
                      variant="primary"
                      disabled={busy}
                      onClick={() => setPluginConfirm({ id: plugin.id, decision: 'approve' })}
                    />
                    <Button
                      label={t('setup.plugin_deny')}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setPluginConfirm({ id: plugin.id, decision: 'deny' })}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SettingsGroup>
    </div>
  );
}
