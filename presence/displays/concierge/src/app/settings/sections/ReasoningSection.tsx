'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  SecretField,
  Select,
  SettingRow,
  SettingsGroup,
  TextField,
} from '@agent/shared-ui';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../../lib/i18n';
import { applySecret, proposeSecret } from '../settings-api';
import { FormScope, asText } from './form-scope';
import { CliSettingRow, SettingMeta } from './settings-ia-parts';

type SetupKind = 'always' | 'cli' | 'api_key' | 'endpoint' | 'unsupported';
type CandidateSetup = {
  kind: SetupKind;
  env_names: string[];
  secret_service_id?: string;
  secret_key?: string;
  credential_ready?: boolean;
  endpoint_env_name?: string;
  endpoint_configured?: boolean;
  endpoint_policy?: 'local' | 'public';
  hint?: string;
};
type Candidate = {
  provider: string;
  display_name: string;
  status: 'ready' | 'needs_setup' | 'unsupported';
  selectable: boolean;
  model_ids: string[];
  reason: string;
  setup?: CandidateSetup;
};
type Snapshot = {
  ok: boolean;
  preferences: { provider?: string; model_id?: string } | null;
  candidates: Candidate[];
  error?: string;
};

type SetupState = {
  approvalId?: string;
  storageChannel?: string;
  pending?: boolean;
  error?: string;
  done?: boolean;
  applyStatus?: 'idle' | 'pending' | 'error' | 'saved';
};

function kindKey(kind: SetupKind | undefined): FrontDeskMessageKey {
  if (kind === 'api_key') return 'ia_settings_reasoning_kind_api';
  if (kind === 'endpoint') return 'ia_settings_reasoning_kind_local';
  return 'ia_settings_reasoning_kind_cli';
}

/**
 * エージェントと自律度 › 推論エンジンとモデル (`#settings-reasoning`): the one
 * place the reasoning engine and model are chosen (`/api/llm-selection`).
 * Candidates arrive grouped by the server: `ready` engines are selectable,
 * `needs_setup` engines offer an inline registration flow (governed secret
 * introduction for API keys, `.env.local` persistence for endpoint URLs),
 * and `unsupported` engines stay collapsed. Saving happens only on the
 * explicit button; the typed secret value never enters component state.
 */
export function ReasoningSection({ locale }: { locale: ConciergeLocale }) {
  const text = (key: FrontDeskMessageKey) => frontDeskText(key, locale);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [provider, setProvider] = React.useState('');
  const [model, setModel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null);
  const [openSetup, setOpenSetup] = React.useState<string | null>(null);
  const [setupState, setSetupState] = React.useState<Record<string, SetupState>>({});
  const [endpointUrl, setEndpointUrl] = React.useState<Record<string, string>>({});

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
  const needsSetup = candidates.filter((c) => c.status === 'needs_setup');
  const unsupported = candidates.filter((c) => c.status === 'unsupported');
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

  const patchSetup = (key: string, patch: SetupState) =>
    setSetupState((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  async function beginApiKeySetup(candidate: Candidate) {
    const setup = candidate.setup;
    if (!setup?.secret_service_id || !setup.secret_key) return;
    if (openSetup === candidate.provider) {
      setOpenSetup(null);
      return;
    }
    setOpenSetup(candidate.provider);
    if (setupState[candidate.provider]?.approvalId) return;
    patchSetup(candidate.provider, { pending: true, error: undefined });
    const result = await proposeSecret({
      serviceId: setup.secret_service_id,
      secretKey: setup.secret_key,
      reason: `Reasoning engine ${candidate.provider} setup from settings`,
    });
    if (!result.ok) {
      patchSetup(candidate.provider, {
        pending: false,
        error: result.error || text('ia_settings_reasoning_setup_failed'),
      });
      return;
    }
    patchSetup(candidate.provider, {
      pending: false,
      approvalId: result.approvalId,
      storageChannel: result.storageChannel,
    });
  }

  async function applyApiKey(candidate: Candidate, value: string) {
    const state = setupState[candidate.provider];
    if (!state?.approvalId || !value) return;
    patchSetup(candidate.provider, { applyStatus: 'pending', error: undefined });
    const result = await applySecret({
      approvalId: state.approvalId,
      value,
      storageChannel: state.storageChannel || 'concierge',
    });
    if (!result.ok) {
      patchSetup(candidate.provider, {
        applyStatus: 'error',
        error: result.error || text('ia_settings_reasoning_setup_failed'),
      });
      return;
    }
    patchSetup(candidate.provider, { applyStatus: 'saved', done: true });
    setOpenSetup(null);
    setMessage({ text: text('ia_settings_reasoning_setup_registered'), error: false });
    load();
  }

  async function saveEndpoint(candidate: Candidate) {
    const url = (endpointUrl[candidate.provider] || '').trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
      patchSetup(candidate.provider, {
        error: text('ia_settings_reasoning_endpoint_invalid'),
      });
      return;
    }
    patchSetup(candidate.provider, { pending: true, error: undefined });
    try {
      const res = await fetch('/api/llm-selection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save_endpoint', provider: candidate.provider, url }),
      });
      const body: Snapshot = await res.json();
      if (body.ok === false) {
        patchSetup(candidate.provider, {
          pending: false,
          error: body.error || text('ia_settings_reasoning_setup_failed'),
        });
        return;
      }
      patchSetup(candidate.provider, { pending: false, done: true });
      setSnapshot(body);
      setOpenSetup(null);
      setMessage({ text: text('ia_settings_reasoning_setup_registered'), error: false });
    } catch {
      patchSetup(candidate.provider, {
        pending: false,
        error: text('ia_settings_reasoning_setup_failed'),
      });
    }
  }

  function setupForm(candidate: Candidate) {
    const setup = candidate.setup;
    if (!setup) return null;
    const state = setupState[candidate.provider] || {};
    if (setup.kind === 'api_key' && setup.secret_service_id) {
      if (state.pending) {
        return (
          <p className="kb-text kb-text--muted" role="status">
            {text('ia_settings_reasoning_setup_pending')}
          </p>
        );
      }
      if (!state.approvalId) return null;
      return (
        <FormScope
          actions={{
            [`reasoning.secret.${candidate.provider}`]: (payload) => {
              void applyApiKey(candidate, typeof payload.value === 'string' ? payload.value : '');
            },
          }}
        >
          <SecretField
            id={`reasoning-secret-${candidate.provider}`}
            name={`reasoning.secret.${candidate.provider}`}
            label={text('ia_settings_reasoning_apikey_label')}
            help={text('ia_settings_reasoning_apikey_help')}
            service_id={setup.secret_service_id}
            secret_key={setup.secret_key}
            configured={setup.credential_ready === true || state.applyStatus === 'saved'}
            disabled={busy || state.applyStatus === 'pending'}
            action={{ id: `reasoning.secret.${candidate.provider}` }}
            status={state.applyStatus ?? 'idle'}
            status_error={state.error}
          />
        </FormScope>
      );
    }
    if (setup.kind === 'endpoint' && setup.endpoint_env_name) {
      return (
        <FormScope
          fields={{
            [`reasoning.endpoint.${candidate.provider}`]: (value) =>
              setEndpointUrl((current) => ({ ...current, [candidate.provider]: asText(value) })),
          }}
        >
          <SettingRow label={text('ia_settings_reasoning_endpoint_label')}>
            <TextField
              id={`reasoning-endpoint-${candidate.provider}`}
              name={`reasoning.endpoint.${candidate.provider}`}
              label={text('ia_settings_reasoning_endpoint_label')}
              hide_label
              value={endpointUrl[candidate.provider] ?? ''}
              disabled={busy || state.pending}
              placeholder={text('ia_settings_reasoning_endpoint_help')}
            />
          </SettingRow>
          <div className="settings-row-actions">
            <Button
              label={text('ia_settings_reasoning_setup_register')}
              variant="secondary"
              disabled={busy || state.pending || !(endpointUrl[candidate.provider] || '').trim()}
              onClick={() => void saveEndpoint(candidate)}
            />
          </div>
        </FormScope>
      );
    }
    return null;
  }

  function setupRow(candidate: Candidate) {
    const setup = candidate.setup;
    const state = setupState[candidate.provider] || {};
    const actionable = setup?.kind === 'api_key' || setup?.kind === 'endpoint';
    return (
      <li key={candidate.provider} className="settings-row-block">
        <SettingRow
          label={candidate.display_name}
          description={
            setup?.kind === 'cli'
              ? setup?.hint || text('ia_settings_reasoning_setup_cli_hint')
              : candidate.reason
          }
        >
          <Badge label={text(kindKey(setup?.kind))} tone="neutral" />
          {actionable ? (
            <Button
              label={text(
                setup?.kind === 'api_key'
                  ? 'ia_settings_reasoning_setup_apikey'
                  : 'ia_settings_reasoning_setup_endpoint'
              )}
              variant="secondary"
              disabled={busy}
              onClick={() =>
                setup?.kind === 'api_key'
                  ? void beginApiKeySetup(candidate)
                  : setOpenSetup((current) =>
                      current === candidate.provider ? null : candidate.provider
                    )
              }
            />
          ) : null}
        </SettingRow>
        {openSetup === candidate.provider ? setupForm(candidate) : null}
        {state.error ? (
          <p role="alert" className="kb-text kb-text--body">
            {state.error}
          </p>
        ) : null}
      </li>
    );
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
          {!snapshot && !message ? (
            <div className="settings-row-block">
              <p className="kb-text kb-text--muted" role="status">
                {text('ia_settings_reasoning_loading')}
              </p>
            </div>
          ) : null}
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
          {needsSetup.length > 0 ? (
            <div className="settings-row-block">
              <p className="kb-text kb-text--muted">{text('ia_settings_reasoning_setup_lead')}</p>
              <ul className="settings-plain-list">{needsSetup.map(setupRow)}</ul>
            </div>
          ) : null}
          {unsupported.length > 0 ? (
            <details className="kb-disclosure settings-disclosure">
              <summary>{text('ia_settings_reasoning_unsupported_group')}</summary>
              <div className="kb-disclosure__body">
                <ul className="settings-plain-list">
                  {unsupported.map((c) => (
                    <li key={c.provider} className="kb-text kb-text--muted">
                      {c.display_name} — {c.reason}
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
