'use client';

import * as React from 'react';
import { Button, Select, SettingRow, SettingsGroup } from '@agent/shared-ui';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../../lib/i18n';
import { FormScope, asText } from './form-scope';
import { CliSettingRow, SettingMeta } from './settings-ia-parts';

type Candidate = {
  provider: string;
  display_name: string;
  status: 'ready' | 'needs_setup' | 'unsupported';
  selectable: boolean;
  model_ids: string[];
  reason: string;
};
type Snapshot = {
  ok: boolean;
  preferences: { provider?: string; model_id?: string } | null;
  candidates: Candidate[];
  error?: string;
};

/**
 * エージェントと自律度 › 推論エンジンとモデル (`#settings-reasoning`): the one
 * place the reasoning engine and model are chosen (`/api/llm-selection`).
 * Other screens (agent panel, advanced settings) link here instead of
 * offering their own picker. Saving happens only on the explicit button.
 */
export function ReasoningSection({ locale }: { locale: ConciergeLocale }) {
  const text = (key: FrontDeskMessageKey) => frontDeskText(key, locale);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [provider, setProvider] = React.useState('');
  const [model, setModel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null);

  const load = React.useCallback(() => {
    const failed = () =>
      setMessage({ text: frontDeskText('ia_settings_reasoning_load_failed', locale), error: true });
    void fetch('/api/llm-selection')
      .then((res) => res.json())
      .then((body: Snapshot) => {
        if (body.ok === false) return failed();
        setSnapshot(body);
        setProvider(body.preferences?.provider ?? '');
        setModel(body.preferences?.model_id ?? '');
      })
      .catch(failed);
  }, [locale]);
  React.useEffect(load, [load]);

  const candidates = snapshot?.candidates ?? [];
  const selected = candidates.find((c) => c.provider === provider);
  const selectable = candidates.filter((c) => c.selectable);
  const unavailable = candidates.filter((c) => !c.selectable);
  const saved = snapshot?.preferences;
  const savedName = saved?.provider
    ? `${candidates.find((c) => c.provider === saved.provider)?.display_name ?? saved.provider}${
        saved.model_id ? ` · ${saved.model_id}` : ''
      }`
    : text('ia_settings_reasoning_none');
  const changed = provider !== (saved?.provider ?? '') || model !== (saved?.model_id ?? '');

  async function save() {
    if (!provider) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/llm-selection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, ...(model ? { model_id: model } : {}) }),
      });
      const body: Snapshot = await res.json();
      if (body.ok === false)
        setMessage({ text: text('ia_settings_reasoning_failed'), error: true });
      else {
        setSnapshot(body);
        setMessage({ text: text('ia_settings_reasoning_saved'), error: false });
      }
    } catch {
      setMessage({ text: text('ia_settings_reasoning_failed'), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormScope
      fields={{
        'reasoning.provider': (value) => {
          setProvider(asText(value));
          setModel('');
        },
        'reasoning.model': (value) => setModel(asText(value)),
      }}
    >
      <div className="settings-subsection" id="settings-reasoning">
        <SettingsGroup
          id="settings-reasoning-group"
          title={text('ia_settings_card_reasoning')}
          description={text('ia_settings_card_reasoning_desc')}
        >
          <div className="settings-row-block">
            <SettingMeta
              locale={locale}
              current={snapshot ? savedName : undefined}
              defaultValue={text('ia_settings_card_reasoning_default')}
              effect={text('ia_settings_card_reasoning_effect')}
            />
          </div>
          {snapshot && selectable.length === 0 ? (
            <div className="settings-row-block">
              <p className="kb-text kb-text--muted">{text('ia_settings_reasoning_none_ready')}</p>
            </div>
          ) : null}
          {selectable.length > 0 ? (
            <>
              <SettingRow label={text('ia_settings_reasoning_provider')}>
                <Select
                  id="reasoning-provider"
                  name="reasoning.provider"
                  label={text('ia_settings_reasoning_provider')}
                  hide_label
                  value={provider}
                  disabled={busy}
                  placeholder={text('ia_settings_reasoning_none')}
                  options={selectable.map((c) => ({ value: c.provider, label: c.display_name }))}
                />
              </SettingRow>
              {selected && selected.model_ids.length > 0 ? (
                <SettingRow label={text('ia_settings_reasoning_model')}>
                  <Select
                    id="reasoning-model"
                    name="reasoning.model"
                    label={text('ia_settings_reasoning_model')}
                    hide_label
                    value={model}
                    disabled={busy}
                    placeholder={text('ia_settings_reasoning_model_default')}
                    options={selected.model_ids.map((id) => ({ value: id, label: id }))}
                  />
                </SettingRow>
              ) : null}
              <div className="settings-row-actions">
                <Button
                  label={text('ia_settings_reasoning_save')}
                  variant="primary"
                  disabled={busy || !provider || !changed}
                  onClick={() => void save()}
                />
              </div>
            </>
          ) : null}
          {message ? (
            <div className="settings-row-block">
              <p role={message.error ? 'alert' : 'status'} className="kb-text kb-text--body">
                {message.text}
              </p>
            </div>
          ) : null}
          {unavailable.length > 0 ? (
            <details className="kb-disclosure settings-disclosure">
              <summary>{text('ia_settings_reasoning_unavailable')}</summary>
              <div className="kb-disclosure__body">
                <ul className="settings-plain-list">
                  {unavailable.map((c) => (
                    <li key={c.provider} className="kb-text kb-text--muted">
                      {c.display_name}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}
          <CliSettingRow
            locale={locale}
            label={text('ia_settings_reasoning_install')}
            description={text('ia_settings_cli_lead')}
            command="pnpm reasoning:setup"
          />
        </SettingsGroup>
      </div>
    </FormScope>
  );
}
