'use client';

import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';

import * as React from 'react';
import { Button, Select, SettingRow, TextField } from '@agent/shared-ui';
import {
  ENGINE_CONFIG_FIELDS,
  ENGINE_CONFIG_HELP,
  engineConfigChanges,
  engineConfigFailure,
  parseEngineConfig,
  type EngineConfigField,
  type EngineConfigSnapshot,
  type EngineConfigValues,
} from '../../../lib/engine-config-view';
import {
  presenceStudioText,
  type ConciergeLocale,
  type PresenceStudioMessageKey,
} from '../../../lib/i18n';
import { FormScope, asText } from './form-scope';

const ENDPOINT = '/api/voice/engine-config';

type Status =
  | 'loading'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'unchanged'
  | 'load_failed'
  | 'save_failed'
  | 'denied'
  | 'conflict'
  | 'invalid';
const ERROR_STATUSES = new Set<Status>([
  'load_failed',
  'save_failed',
  'denied',
  'conflict',
  'invalid',
]);

class RequestFailure extends Error {
  constructor(readonly status: number) {
    super('engine_config_request_failed');
  }
}

/**
 * 設定 › エンジン: edits this machine's engine runtime defaults in place
 * (formerly presence-studio `/engine-config`). Only the local operator may
 * read or save them (`/api/voice/engine-config` refuses everyone else); a
 * save carries the loaded revision, so a change made elsewhere is a conflict,
 * never an overwrite.
 */
export function EngineConfigPanel({ locale }: { locale: ConciergeLocale }) {
  const text = React.useCallback(
    (key: PresenceStudioMessageKey) => presenceStudioText(key, locale),
    [locale]
  );
  const [snapshot, setSnapshot] = React.useState<EngineConfigSnapshot | null>(null);
  const [draft, setDraft] = React.useState<EngineConfigValues | null>(null);
  const [status, setStatus] = React.useState<Status>('loading');
  const [busy, setBusy] = React.useState(false);

  const request = React.useCallback(async (init?: RequestInit) => {
    const response = await fetch(ENDPOINT, { cache: 'no-store', ...init });
    const parsed = parseEngineConfig(await response.json().catch(() => null));
    if (!response.ok || !parsed) throw new RequestFailure(response.ok ? 500 : response.status);
    return parsed;
  }, []);

  const apply = (next: EngineConfigSnapshot) => {
    setSnapshot(next);
    setDraft(next.values);
  };

  const load = React.useCallback(async () => {
    setBusy(true);
    setStatus('loading');
    try {
      apply(await request());
      setStatus('ready');
    } catch (error) {
      setSnapshot(null);
      setDraft(null);
      setStatus(
        engineConfigFailure(error instanceof RequestFailure ? error.status : 0, 'load_failed')
      );
    } finally {
      setBusy(false);
    }
  }, [request]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const changes = snapshot && draft ? engineConfigChanges(snapshot.values, draft) : null;
  const dirty = Boolean(
    changes && (Object.keys(changes.patch).length > 0 || changes.unset.length > 0)
  );

  const save = async () => {
    if (!snapshot || !changes || busy || status === 'conflict') return;
    if (!dirty) {
      setStatus('unchanged');
      return;
    }
    setBusy(true);
    setStatus('saving');
    try {
      apply(
        await request({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...changes, expected_revision: snapshot.revision }),
        })
      );
      setStatus('saved');
    } catch (error) {
      // The edits stay on screen; a conflict asks for a reload first.
      setStatus(
        engineConfigFailure(error instanceof RequestFailure ? error.status : 0, 'save_failed')
      );
    } finally {
      setBusy(false);
    }
  };

  const setField = (key: EngineConfigField) => (value: unknown) => {
    setDraft((current) => (current ? { ...current, [key]: asText(value) } : current));
    // A finished save or "nothing to save" no longer describes the edited form.
    setStatus((current) => (current === 'saved' || current === 'unchanged' ? 'ready' : current));
  };

  const label = (key: EngineConfigField) =>
    text(`engine_config_${key}` as PresenceStudioMessageKey);
  const help = (key: EngineConfigField) => {
    const kind = ENGINE_CONFIG_HELP[key];
    return kind ? text(`engine_config_${kind}_help` as PresenceStudioMessageKey) : undefined;
  };

  return (
    <FormScope
      fields={Object.fromEntries(
        ENGINE_CONFIG_FIELDS.map((key) => [`engine.${key}`, setField(key)])
      )}
    >
      <div className="settings-row-block settings-engine-config" aria-busy={busy}>
        {snapshot ? (
          <p className="kb-text kb-text--caption">
            {text('engine_config_profile')}:{' '}
            {text(`engine_config_profile_${snapshot.profile.kind}`)}
            {snapshot.profile.kind === 'customer' ? ` · ${snapshot.profile.id}` : ''}
          </p>
        ) : null}
        {draft ? (
          <>
            <p className="kb-text kb-text--muted">{text('engine_config_clear_help')}</p>
            {ENGINE_CONFIG_FIELDS.map((key) => (
              <SettingRow key={key} label={label(key)} description={help(key)}>
                {key === 'agent_runtime_backend' ? (
                  <Select
                    id={`engine-${key}`}
                    name={`engine.${key}`}
                    label={label(key)}
                    hide_label
                    value={draft[key]}
                    disabled={busy}
                    options={[
                      { value: '', label: text('engine_config_mode_default') },
                      { value: 'pipe', label: text('engine_config_mode_pipe') },
                      { value: 'pane', label: text('engine_config_mode_pane') },
                    ]}
                  />
                ) : key === 'agent_pane_runtime_provider' &&
                  (snapshot?.pane_providers.length ?? 0) > 0 ? (
                  <Select
                    id={`engine-${key}`}
                    name={`engine.${key}`}
                    label={label(key)}
                    hide_label
                    value={draft[key]}
                    disabled={busy}
                    options={[
                      { value: '', label: text('engine_config_mode_default') },
                      ...(snapshot?.pane_providers ?? []).map((id) => ({ value: id, label: id })),
                    ]}
                  />
                ) : (
                  <TextField
                    id={`engine-${key}`}
                    name={`engine.${key}`}
                    label={label(key)}
                    hide_label
                    value={draft[key]}
                    disabled={busy}
                  />
                )}
              </SettingRow>
            ))}
          </>
        ) : null}
        <div className="settings-row-actions settings-row-actions--start">
          {draft ? (
            <Button
              label={text('engine_config_save')}
              variant="primary"
              disabled={busy || !dirty || status === 'conflict'}
              onClick={() => void save()}
            />
          ) : null}
          <Button
            label={text('engine_config_reload')}
            variant="secondary"
            disabled={busy}
            onClick={() => void load()}
          />
        </div>
        <p
          role="status"
          aria-live="polite"
          className={
            ERROR_STATUSES.has(status) ? 'kb-text kb-text--danger' : 'kb-text kb-text--muted'
          }
        >
          {text(`engine_config_${status}` as PresenceStudioMessageKey)}
        </p>
      </div>
    </FormScope>
  );
}
