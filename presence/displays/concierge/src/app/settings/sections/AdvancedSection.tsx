'use client';

import * as React from 'react';
import { Button, SettingRow, SettingsGroup, Select, StatusPill, TextField } from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';
import type { ConfigMissionItem, ConfigPreset, Setup } from '../../../lib/settings-types';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** FD-06 詳細設定 pane (`#settings-advanced`) — the 3 collapsed sub-panes
 * (管理情報 / ガバナンス設定 / 運用オプション), each keeping its own legacy
 * `#setup-…` anchor inside a `<details>` (deep links open it). Extracted
 * from settings/page.tsx; every handler stays owned by the page. UI-06:
 * `kb-disclosure` + shared settings rows. */

const CONFIG_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  draft: 'setup.governance_status_draft',
  applying: 'setup.governance_status_in_progress',
  applied: 'setup.governance_status_done',
  failed: 'setup.governance_status_failed',
};

const CONFIG_STATUS_PILL: Record<string, KbStatus> = {
  draft: 'pending',
  applying: 'working',
  applied: 'done',
  failed: 'failed',
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
  t: SettingsTranslate;
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
  const preset = configPresets.find((candidate) => candidate.id === configPresetId);
  const setMgmt = (field: keyof ManagementState) => (value: unknown) =>
    setManagement({ ...management, [field]: asText(value) });
  const presetInputFields = Object.fromEntries(
    (preset?.inputs ?? []).map((input) => [
      `governance.input.${input.key}`,
      (value: unknown) => setConfigInputs({ ...configInputs, [input.key]: asText(value) }),
    ])
  );

  return (
    <div
      className="settings-section"
      id="settings-advanced"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_advanced', locale)}
    >
      <FormScope
        fields={{
          'management.tenant_slug': (value) => {
            const slug = asText(value);
            const selected = setup.tenant.catalog.find((tenant) => tenant.tenant_slug === slug);
            setManagement({
              ...management,
              tenant_slug: slug,
              tenant_display_name: selected?.display_name || slug,
              tenant_role: selected?.assigned_role || management.tenant_role,
            });
          },
          'management.tenant_display_name': setMgmt('tenant_display_name'),
          'management.tenant_role': setMgmt('tenant_role'),
          'management.agent_id': setMgmt('agent_id'),
          'management.agent_display_name': setMgmt('agent_display_name'),
          'management.agent_provider': setMgmt('agent_provider'),
          'management.agent_model_id': setMgmt('agent_model_id'),
          'governance.preset': (value) => {
            setConfigPresetId(asText(value));
            setConfigInputs({});
            setConfigConfirm(false);
          },
          'governance.tenant': (value) => setConfigTenant(asText(value)),
          ...presetInputFields,
        }}
      >
        <SettingsGroup
          id="settings-advanced-group"
          title={frontDeskText('settings_nav_advanced', locale)}
          description={frontDeskText('settings_advanced_lead', locale)}
        >
          {chronosUrl ? (
            <div className="settings-row-actions settings-row-actions--start">
              <Button
                label={frontDeskText('settings_open_chronos', locale)}
                variant="secondary"
                href={chronosUrl}
              />
            </div>
          ) : null}

          <details className="kb-disclosure settings-disclosure">
            <summary>{t('setup.management_title')}</summary>
            <div className="kb-disclosure__body" id="setup-management">
              <p className="kb-text kb-text--muted">{t('setup.management_description')}</p>
              <SettingRow
                label={t('setup.tenant')}
                description={
                  setup.tenant.runtime_bound
                    ? t('setup.tenant_runtime_bound')
                    : t('setup.tenant_runtime_unbound')
                }
              >
                <Select
                  id="management-tenant"
                  name="management.tenant_slug"
                  label={t('setup.tenant')}
                  hide_label
                  value={management.tenant_slug}
                  options={setup.tenant.catalog.map((tenant) => ({
                    value: tenant.tenant_slug,
                    label: `${tenant.display_name} (${tenant.tenant_slug})`,
                  }))}
                />
              </SettingRow>
              {(
                [
                  ['tenant_display_name', 'setup.tenant_display_name', undefined],
                  ['tenant_role', 'setup.tenant_role', undefined],
                  ['agent_id', 'setup.agent_id', undefined],
                  ['agent_display_name', 'setup.agent_display_name', undefined],
                  ['agent_provider', 'setup.agent_provider', 'codex-cli'],
                  ['agent_model_id', 'setup.agent_model', 'gpt-5.6-luna'],
                ] as Array<[keyof ManagementState, ConciergeMessageKey, string | undefined]>
              ).map(([field, labelKey, placeholder]) => (
                <SettingRow key={field} label={t(labelKey)}>
                  <TextField
                    id={`management-${field}`}
                    name={`management.${field}`}
                    label={t(labelKey)}
                    hide_label
                    value={management[field]}
                    placeholder={placeholder}
                  />
                </SettingRow>
              ))}
              <p className="kb-text kb-text--caption">
                {t('setup.agent_registry_count', {
                  count: setup.agent_management.durable_identities.length,
                })}
              </p>
              <div className="settings-inline-actions">
                <Button
                  label={t('setup.save_management')}
                  variant="primary"
                  disabled={busy}
                  onClick={onSaveManagement}
                />
              </div>
            </div>
          </details>

          <details className="kb-disclosure settings-disclosure">
            <summary>{t('setup.governance_title')}</summary>
            <div className="kb-disclosure__body" id="setup-governance">
              <p className="kb-text kb-text--muted">{t('setup.governance_description')}</p>
              <SettingRow label={t('setup.governance_preset')}>
                <Select
                  id="governance-preset"
                  name="governance.preset"
                  label={t('setup.governance_preset')}
                  hide_label
                  value={configPresetId}
                  placeholder={t('setup.governance_preset_placeholder')}
                  options={configPresets.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.id,
                  }))}
                />
              </SettingRow>
              {preset ? (
                <>
                  <p className="kb-text kb-text--muted">{preset.description}</p>
                  <p className="kb-text kb-text--caption">
                    {t('setup.governance_targets', { count: preset.write_target_count })}
                  </p>
                  <SettingRow label={t('setup.governance_tenant')}>
                    <Select
                      id="governance-tenant"
                      name="governance.tenant"
                      label={t('setup.governance_tenant')}
                      hide_label
                      value={configTenant}
                      options={configTenants.map((tenant) => ({ value: tenant, label: tenant }))}
                    />
                  </SettingRow>
                  {preset.inputs.map((input) => {
                    const label = `${input.key}${
                      input.required ? ` (${t('setup.governance_required')})` : ''
                    }`;
                    const name = `governance.input.${input.key}`;
                    const id = `governance-input-${input.key}`;
                    return (
                      <SettingRow key={input.key} label={label} description={input.description}>
                        {input.type === 'enum' && input.values ? (
                          <Select
                            id={id}
                            name={name}
                            label={label}
                            hide_label
                            value={configInputs[input.key] || input.default || ''}
                            placeholder={t('setup.governance_preset_placeholder')}
                            options={input.values.map((value) => ({ value, label: value }))}
                          />
                        ) : input.type === 'boolean' ? (
                          <Select
                            id={id}
                            name={name}
                            label={label}
                            hide_label
                            value={configInputs[input.key] || input.default || 'false'}
                            options={[
                              { value: 'false', label: 'false' },
                              { value: 'true', label: 'true' },
                            ]}
                          />
                        ) : input.type === 'secret' ? (
                          // Preset `secret` inputs are part of the governed
                          // config-mission payload (unchanged contract), so they
                          // stay a masked controlled input rather than SecretField.
                          <input
                            className="kb-input"
                            type="password"
                            autoComplete="off"
                            aria-label={label}
                            value={configInputs[input.key] || ''}
                            onChange={(event) =>
                              setConfigInputs({ ...configInputs, [input.key]: event.target.value })
                            }
                          />
                        ) : (
                          <TextField
                            id={id}
                            name={name}
                            label={label}
                            hide_label
                            value={configInputs[input.key] || ''}
                          />
                        )}
                      </SettingRow>
                    );
                  })}
                  {configConfirm ? (
                    <div className="settings-row-confirm" role="group">
                      <p className="kb-text kb-text--body">{t('setup.governance_confirm')}</p>
                      <div className="settings-inline-actions">
                        <Button
                          label={t('setup.confirm_yes')}
                          variant="primary"
                          disabled={busy}
                          onClick={onSubmitConfigMission}
                        />
                        <Button
                          label={t('setup.confirm_back')}
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setConfigConfirm(false)}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="settings-inline-actions">
                      <Button
                        label={t('setup.governance_submit')}
                        variant="primary"
                        disabled={busy || !configTenant}
                        onClick={() => setConfigConfirm(true)}
                      />
                    </div>
                  )}
                </>
              ) : null}
              <h3 className="kb-text kb-text--title">{t('setup.governance_recent')}</h3>
              {configRecent.length === 0 ? (
                <p className="kb-text kb-text--muted">{t('setup.governance_recent_empty')}</p>
              ) : (
                configRecent.map((mission) => {
                  const statusKey = CONFIG_STATUS_KEYS[mission.status];
                  return (
                    <SettingRow
                      key={mission.id}
                      label={mission.preset}
                      description={`${mission.id} · ${mission.tenant}${
                        mission.created_at ? ` · ${mission.created_at.slice(0, 10)}` : ''
                      }`}
                    >
                      <StatusPill
                        status={CONFIG_STATUS_PILL[mission.status] ?? 'n/a'}
                        label={statusKey ? t(statusKey) : mission.status}
                      />
                    </SettingRow>
                  );
                })
              )}
            </div>
          </details>

          <details className="kb-disclosure settings-disclosure">
            <summary>{t('setup.operations_title')}</summary>
            <div className="kb-disclosure__body" id="setup-operations">
              <p className="kb-text kb-text--muted">{t('setup.operations_description')}</p>
              {setup.capabilities.map((capability) => (
                <SettingRow
                  key={capability.id}
                  label={capability.label}
                  description={capability.href ? undefined : t('setup.ask_via_conversation')}
                >
                  <div className="settings-inline-actions">
                    <StatusPill
                      status={capability.status === 'ready' ? 'available' : 'pending'}
                      label={
                        capability.status === 'ready' ? t('setup.available') : t('setup.guided')
                      }
                    />
                    {capability.href?.startsWith('#') ? (
                      <Button
                        label={t('setup.open_section')}
                        variant="ghost"
                        onClick={() => onJumpToSection(capability.href!)}
                      />
                    ) : capability.href ? (
                      <Button
                        label={t('setup.open_approval_queue')}
                        variant="ghost"
                        href={capability.href}
                      />
                    ) : null}
                  </div>
                </SettingRow>
              ))}
            </div>
          </details>
        </SettingsGroup>
      </FormScope>
    </div>
  );
}
