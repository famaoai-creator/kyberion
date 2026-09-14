'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { ConfigMissionItem, ConfigPreset, Setup } from '../../../lib/settings-types';

/** FD-06 詳細設定 pane (`#settings-advanced`) — the 3 collapsed sub-panes
 * (管理情報 / ガバナンス設定 / 運用オプション), each keeping its own legacy
 * `#setup-…` anchor. Extracted from settings/page.tsx; every handler stays
 * owned by the page. */

const CONFIG_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  draft: 'setup.governance_status_draft',
  applying: 'setup.governance_status_in_progress',
  applied: 'setup.governance_status_done',
  failed: 'setup.governance_status_failed',
};

export type ManagementState = {
  tenant_slug: string;
  tenant_display_name: string;
  tenant_role: string;
  agent_id: string;
  agent_display_name: string;
  agent_provider: string;
  agent_model_id: string;
};

export type AdvancedSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
  setup: Setup;
  busy: boolean;
  chronosUrl: string | null;
  sectionRef: (element: HTMLElement | null) => void;

  // 管理情報 (#setup-management)
  management: ManagementState;
  setManagement: (management: ManagementState) => void;
  onSaveManagement: () => void;

  // ガバナンス設定 (#setup-governance)
  configPresets: ConfigPreset[];
  configTenants: string[];
  configTenant: string;
  setConfigTenant: (tenant: string) => void;
  configPresetId: string;
  setConfigPresetId: (presetId: string) => void;
  configInputs: Record<string, string>;
  setConfigInputs: (inputs: Record<string, string>) => void;
  configConfirm: boolean;
  setConfigConfirm: (confirm: boolean) => void;
  configRecent: ConfigMissionItem[];
  onSubmitConfigMission: () => void;

  // 運用オプション (#setup-operations)
  onJumpToSection: (target: string) => void;
};

export function AdvancedSection({
  locale,
  t,
  setup,
  busy,
  chronosUrl,
  sectionRef,
  management,
  setManagement,
  onSaveManagement,
  configPresets,
  configTenants,
  configTenant,
  setConfigTenant,
  configPresetId,
  setConfigPresetId,
  configInputs,
  setConfigInputs,
  configConfirm,
  setConfigConfirm,
  configRecent,
  onSubmitConfigMission,
  onJumpToSection,
}: AdvancedSectionProps) {
  return (
    <section
      className="pane"
      id="settings-advanced"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_advanced', locale)}
    >
      <h2>{frontDeskText('settings_nav_advanced', locale)}</h2>
      <p className="settings-card-lead">{frontDeskText('settings_advanced_lead', locale)}</p>
      {chronosUrl ? (
        <p className="item-meta">
          <a href={chronosUrl}>{frontDeskText('settings_open_chronos', locale)}</a>
        </p>
      ) : null}

      <details className="settings-details">
        <summary>{t('setup.management_title')}</summary>
        <div id="setup-management">
          <p className="pane-subtitle">{t('setup.management_description')}</p>
          <label className="field-label">
            {t('setup.tenant')}
            <select
              value={management.tenant_slug}
              onChange={(event) => {
                const selected = setup.tenant.catalog.find(
                  (tenant) => tenant.tenant_slug === event.target.value
                );
                setManagement({
                  ...management,
                  tenant_slug: event.target.value,
                  tenant_display_name: selected?.display_name || event.target.value,
                  tenant_role: selected?.assigned_role || management.tenant_role,
                });
              }}
            >
              {setup.tenant.catalog.map((tenant) => (
                <option key={tenant.tenant_slug} value={tenant.tenant_slug}>
                  {tenant.display_name} ({tenant.tenant_slug})
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('setup.tenant_display_name')}
            <input
              value={management.tenant_display_name}
              onChange={(event) =>
                setManagement({ ...management, tenant_display_name: event.target.value })
              }
            />
          </label>
          <label className="field-label">
            {t('setup.tenant_role')}
            <input
              value={management.tenant_role}
              onChange={(event) =>
                setManagement({ ...management, tenant_role: event.target.value })
              }
            />
          </label>
          <p className="item-meta">
            {setup.tenant.runtime_bound
              ? t('setup.tenant_runtime_bound')
              : t('setup.tenant_runtime_unbound')}
          </p>
          <label className="field-label">
            {t('setup.agent_id')}
            <input
              value={management.agent_id}
              onChange={(event) => setManagement({ ...management, agent_id: event.target.value })}
            />
          </label>
          <label className="field-label">
            {t('setup.agent_display_name')}
            <input
              value={management.agent_display_name}
              onChange={(event) =>
                setManagement({ ...management, agent_display_name: event.target.value })
              }
            />
          </label>
          <div className="field-row">
            <input
              aria-label={t('setup.agent_provider')}
              value={management.agent_provider}
              onChange={(event) =>
                setManagement({ ...management, agent_provider: event.target.value })
              }
              placeholder="codex-cli"
            />
            <input
              aria-label={t('setup.agent_model')}
              value={management.agent_model_id}
              onChange={(event) =>
                setManagement({ ...management, agent_model_id: event.target.value })
              }
              placeholder="gpt-5.6-luna"
            />
          </div>
          <p className="item-meta">
            {t('setup.agent_registry_count', {
              count: setup.agent_management.durable_identities.length,
            })}
          </p>
          <div className="button-row">
            <button className="action-button" disabled={busy} onClick={onSaveManagement}>
              {t('setup.save_management')}
            </button>
          </div>
        </div>
      </details>

      <details className="settings-details">
        <summary>{t('setup.governance_title')}</summary>
        <div id="setup-governance">
          <p className="pane-subtitle">{t('setup.governance_description')}</p>
          <label className="field-label">
            {t('setup.governance_preset')}
            <select
              value={configPresetId}
              onChange={(event) => {
                setConfigPresetId(event.target.value);
                setConfigInputs({});
                setConfigConfirm(false);
              }}
            >
              <option value="">{t('setup.governance_preset_placeholder')}</option>
              {configPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.id}
                </option>
              ))}
            </select>
          </label>
          {(() => {
            const preset = configPresets.find((candidate) => candidate.id === configPresetId);
            if (!preset) return null;
            return (
              <>
                <p className="item-meta">{preset.description}</p>
                <p className="item-meta">
                  {t('setup.governance_targets', { count: preset.write_target_count })}
                </p>
                <label className="field-label">
                  {t('setup.governance_tenant')}
                  <select
                    value={configTenant}
                    onChange={(event) => setConfigTenant(event.target.value)}
                  >
                    {configTenants.map((tenant) => (
                      <option key={tenant} value={tenant}>
                        {tenant}
                      </option>
                    ))}
                  </select>
                </label>
                {preset.inputs.map((input) => (
                  <label className="field-label" key={input.key}>
                    {input.key}
                    {input.required ? ` (${t('setup.governance_required')})` : ''}
                    {input.type === 'enum' && input.values ? (
                      <select
                        value={configInputs[input.key] || input.default || ''}
                        onChange={(event) =>
                          setConfigInputs({
                            ...configInputs,
                            [input.key]: event.target.value,
                          })
                        }
                      >
                        <option value="">{t('setup.governance_preset_placeholder')}</option>
                        {input.values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    ) : input.type === 'boolean' ? (
                      <select
                        value={configInputs[input.key] || input.default || 'false'}
                        onChange={(event) =>
                          setConfigInputs({
                            ...configInputs,
                            [input.key]: event.target.value,
                          })
                        }
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : (
                      <input
                        type={input.type === 'secret' ? 'password' : 'text'}
                        value={configInputs[input.key] || ''}
                        onChange={(event) =>
                          setConfigInputs({
                            ...configInputs,
                            [input.key]: event.target.value,
                          })
                        }
                      />
                    )}
                    <span className="item-meta">{input.description}</span>
                  </label>
                ))}
                {configConfirm ? (
                  <div className="governance-confirm">
                    <p className="item-body">{t('setup.governance_confirm')}</p>
                    <div className="button-row">
                      <button
                        type="button"
                        className="action-button"
                        disabled={busy}
                        onClick={onSubmitConfigMission}
                      >
                        {t('setup.confirm_yes')}
                      </button>
                      <button
                        type="button"
                        className="action-button secondary"
                        disabled={busy}
                        onClick={() => setConfigConfirm(false)}
                      >
                        {t('setup.confirm_back')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="button-row">
                    <button
                      type="button"
                      className="action-button"
                      disabled={busy || !configTenant}
                      onClick={() => setConfigConfirm(true)}
                    >
                      {t('setup.governance_submit')}
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          <h3 className="pane-subheading">{t('setup.governance_recent')}</h3>
          {configRecent.length === 0 ? (
            <p className="item-meta">{t('setup.governance_recent_empty')}</p>
          ) : (
            configRecent.map((mission) => {
              const statusKey = CONFIG_STATUS_KEYS[mission.status];
              return (
                <div className="item-card" key={mission.id}>
                  <p className="item-title">
                    {mission.preset}
                    <span
                      className={`status-chip${mission.status === 'applied' ? ' ok' : mission.status === 'failed' ? ' attention' : ''}`}
                    >
                      {statusKey ? t(statusKey) : mission.status}
                    </span>
                  </p>
                  <p className="item-meta">
                    {mission.id} · {mission.tenant}
                    {mission.created_at ? ` · ${mission.created_at.slice(0, 10)}` : ''}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </details>

      <details className="settings-details">
        <summary>{t('setup.operations_title')}</summary>
        <div id="setup-operations">
          <p className="pane-subtitle">{t('setup.operations_description')}</p>
          {setup.capabilities.map((capability) => (
            <div className="item-card" key={capability.id}>
              <p className="item-title">
                {capability.label}
                <span
                  className={`status-chip${capability.status === 'guided' ? ' attention' : ''}`}
                >
                  {capability.status === 'ready' ? t('setup.available') : t('setup.guided')}
                </span>
              </p>
              <p className="item-meta">
                {capability.href?.startsWith('#') ? (
                  <button className="link-button" onClick={() => onJumpToSection(capability.href!)}>
                    {t('setup.open_section')}
                  </button>
                ) : capability.href ? (
                  <a href={capability.href}>{t('setup.open_approval_queue')}</a>
                ) : (
                  t('setup.ask_via_conversation')
                )}
              </p>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
