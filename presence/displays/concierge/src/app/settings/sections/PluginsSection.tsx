'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { PluginEntry } from '../../../lib/settings-types';

/** FD-06/CS-03 プラグイン pane (`#setup-plugins`) — extracted from
 * settings/page.tsx; the approve/deny decision handler stays owned by the
 * page. */
const PLUGIN_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  activatable: 'setup.plugin_status_activatable',
  pending_approval: 'setup.plugin_status_pending',
  blocked_broken_manifest: 'setup.plugin_status_blocked',
  not_loadable: 'setup.plugin_status_not_loadable',
};

const PLUGIN_TRUST_KEYS: Record<string, ConciergeMessageKey> = {
  official: 'setup.plugin_trust_official',
  curated: 'setup.plugin_trust_curated',
  'third-party': 'setup.plugin_trust_third_party',
};

export type PluginConfirmState = { id: string; decision: 'approve' | 'deny' } | null;

export type PluginsSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
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
    <section
      className="pane"
      id="setup-plugins"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_plugins', locale)}
    >
      <h2>{frontDeskText('settings_nav_plugins', locale)}</h2>
      <h3 className="pane-subheading">{t('setup.plugins_title')}</h3>
      <p className="pane-subtitle">{t('setup.plugins_description')}</p>
      <p className="item-meta">{t('setup.plugins_caveat')}</p>
      {plugins.length === 0 ? (
        <p className="pane-empty">{t('setup.plugins_empty')}</p>
      ) : (
        plugins.map((plugin) => {
          const statusKey =
            plugin.approval_status === 'rejected'
              ? 'setup.plugin_status_denied'
              : PLUGIN_STATUS_KEYS[plugin.status];
          const trustKey = PLUGIN_TRUST_KEYS[plugin.trust];
          const decidable = plugin.status === 'pending_approval';
          return (
            <div className="item-card" key={`${plugin.source}-${plugin.id}`}>
              <p className="item-title">
                {plugin.id}
                <span
                  className={`status-chip${plugin.status === 'activatable' ? ' ok' : ' attention'}`}
                >
                  {statusKey ? t(statusKey) : plugin.status}
                </span>
              </p>
              <p className="item-meta">
                {trustKey ? t(trustKey) : plugin.trust}
                {plugin.requested_by
                  ? ` · ${t('setup.plugin_requested_by', { value: plugin.requested_by })}`
                  : ''}
              </p>
              {decidable && pluginConfirm?.id === plugin.id ? (
                <div className="plugin-confirm">
                  <p className="item-body">
                    {t(
                      pluginConfirm.decision === 'approve'
                        ? 'setup.plugin_confirm_approve'
                        : 'setup.plugin_confirm_deny'
                    )}
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="action-button"
                      disabled={busy}
                      onClick={() => onDecidePlugin(plugin.id, pluginConfirm.decision)}
                    >
                      {t('setup.confirm_yes')}
                    </button>
                    <button
                      type="button"
                      className="action-button secondary"
                      disabled={busy}
                      onClick={() => setPluginConfirm(null)}
                    >
                      {t('setup.confirm_back')}
                    </button>
                  </div>
                </div>
              ) : decidable ? (
                <div className="button-row">
                  <button
                    type="button"
                    className="action-button"
                    disabled={busy}
                    onClick={() => setPluginConfirm({ id: plugin.id, decision: 'approve' })}
                  >
                    {t('setup.plugin_approve')}
                  </button>
                  <button
                    type="button"
                    className="action-button secondary"
                    disabled={busy}
                    onClick={() => setPluginConfirm({ id: plugin.id, decision: 'deny' })}
                  >
                    {t('setup.plugin_deny')}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
