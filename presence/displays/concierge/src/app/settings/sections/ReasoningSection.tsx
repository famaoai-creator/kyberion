'use client';

import * as React from 'react';
import { frontDeskFetch as fetch } from '../../../lib/front-desk-fetch';
import type { SettingsTranslate } from './form-scope';

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

export function ReasoningSection({ t }: { t: SettingsTranslate }) {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [provider, setProvider] = React.useState('');
  const [model, setModel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void fetch('/api/llm-selection')
      .then((res) => res.json())
      .then((body: Snapshot) => {
        if (body.ok !== false) {
          setSnapshot(body);
          setProvider(body.preferences?.provider ?? '');
          setModel(body.preferences?.model_id ?? '');
        } else setMessage(body.error ?? t('reasoning.load_failed'));
      })
      .catch(() => setMessage(t('reasoning.load_failed')));
  }, [t]);
  React.useEffect(load, [load]);

  const selected = snapshot?.candidates.find((c) => c.provider === provider);
  const selectable = snapshot?.candidates.filter((c) => c.selectable) ?? [];

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
      if (body.ok === false) setMessage(body.error ?? t('reasoning.save_failed'));
      else {
        setSnapshot(body);
        setMessage(t('reasoning.saved'));
      }
    } catch {
      setMessage(t('reasoning.save_failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pane" aria-label={t('reasoning.title')}>
      <h3>{t('reasoning.title')}</h3>
      {selectable.length === 0 ? (
        <p>{t('reasoning.none_ready')}</p>
      ) : (
        <>
          <label>
            {t('reasoning.provider')}
            <select
              value={provider}
              disabled={busy}
              onChange={(event) => {
                setProvider(event.target.value);
                setModel('');
              }}
            >
              <option value="">{t('authority.choose')}</option>
              {selectable.map((c) => (
                <option key={c.provider} value={c.provider}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          {selected && selected.model_ids.length > 0 ? (
            <label>
              {t('reasoning.model')}
              <select
                value={model}
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">{t('reasoning.model_default')}</option>
                {selected.model_ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="button" disabled={busy || !provider} onClick={() => void save()}>
            {t('reasoning.save')}
          </button>
        </>
      )}
      {(snapshot?.candidates.filter((c) => !c.selectable) ?? []).length > 0 ? (
        <details>
          <summary>{t('reasoning.unavailable')}</summary>
          <ul>
            {(snapshot?.candidates ?? [])
              .filter((c) => !c.selectable)
              .map((c) => (
                <li key={c.provider}>
                  {c.display_name} — {c.reason}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
