'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { KbI18nProvider } from '@agent/shared-ui';
import { pickByLocale } from '@agent/core/locale-normalize';
import SelectionSettings from '../../../src/components/SelectionSettings';
import { operatorUiMessages, type OperatorLocale } from '../../../src/lib/i18n';
import {
  SelectionResponseError,
  type SelectionRequest,
  type SelectionRow,
  type SelectionSnapshot,
  type SelectionTarget,
  type SelectionTransport,
} from '../../../src/lib/selection-contract';

const missionInitial: SelectionSnapshot = {
  revision: '1',
  canEdit: true,
  rows: [
    {
      role: 'implementer',
      requested: { mode: 'auto' },
      effective: {
        agent_id: 'agent-atlas',
        provider: 'fixture-provider',
        model: 'fixture-model-a',
      },
      source: 'auto',
      reason: 'Synthetic cached eligible actor.',
      valid: true,
      fallback: false,
      choices: [
        {
          value: 'agent-atlas',
          provider: 'fixture-provider',
          model: 'fixture-model-a',
          eligible: true,
        },
        {
          value: 'agent-lyra',
          provider: 'fixture-provider',
          model: 'fixture-model-b',
          eligible: true,
        },
        { value: 'agent-offline', eligible: false, reason: 'Synthetic unavailable actor' },
      ],
    },
  ],
};
const reasoningInitial: SelectionSnapshot = {
  revision: '1',
  canEdit: true,
  rows: [
    {
      role: 'planner',
      requested: null,
      effective: { runtime_mode: 'stub', provider: 'fixture-provider', model: 'fixture-model-a' },
      source: 'legacy',
      reason: 'Synthetic legacy route; no explicit selection.',
      valid: true,
      fallback: false,
      choices: [
        { value: 'stub', provider: 'fixture-provider', eligible: true },
        { value: 'fixture-sdk', provider: 'fixture-provider', eligible: true },
        { value: 'fixture-offline', eligible: false, reason: 'Synthetic unavailable runtime' },
      ],
    },
  ],
};
const readonlyInitial = { ...missionInitial, canEdit: false };
function previewRow(row: SelectionRow, selection: SelectionRequest): SelectionRow {
  const unavailable =
    selection.agent_id === 'agent-offline' || selection.runtime_mode === 'fixture-offline';
  const blocked = unavailable && selection.mode === 'fixed';
  const fallback = unavailable && selection.mode === 'preferred';
  return {
    ...row,
    requested: { ...selection },
    valid: !blocked,
    fallback,
    effective: blocked
      ? null
      : fallback || selection.mode === 'auto'
        ? row.effective
        : { ...row.effective, ...selection },
    source: blocked
      ? 'blocked'
      : fallback
        ? 'fallback'
        : selection.mode === 'auto'
          ? 'auto'
          : 'requested',
    reason: blocked
      ? 'Synthetic fixed target unavailable; no fallback.'
      : fallback
        ? 'Synthetic preferred target unavailable; automatic fallback.'
        : 'Synthetic cached selection preview.',
  };
}
export default function SelectionFixture() {
  const [page, setPage] = useState('mission');
  const [locale, setLocale] = useState<OperatorLocale>('en');
  const [dark, setDark] = useState(false);
  const [counts, setCounts] = useState({ reads: 0, previews: 0, saves: 0, writes: 0, rejected: 0 });
  const [revision, setRevision] = useState(1);
  const store = useRef({
    mission: structuredClone(missionInitial),
    reasoning: structuredClone(reasoningInitial),
  });
  const transport = useCallback<SelectionTransport>(async (target, command, signal) => {
    const kind = target.kind;
    setCounts((n) => ({
      ...n,
      reads: n.reads + (command ? 0 : 1),
      previews: n.previews + (command?.action === 'preview' ? 1 : 0),
      saves: n.saves + (command?.action === 'save' ? 1 : 0),
    }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, command ? 700 : 100);
      if (signal.aborted && command?.action !== 'save') {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          if (command?.action !== 'save') {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        },
        { once: true }
      );
    });
    const current = store.current[kind];
    if (!command)
      return structuredClone({ ...current, canEdit: target.missionId !== 'MSN-READONLY' });
    if (command.expectedRevision !== current.revision) {
      setCounts((n) => ({ ...n, rejected: n.rejected + 1 }));
      throw new SelectionResponseError(409, 'STALE_SELECTION');
    }
    const next = {
      ...current,
      rows: current.rows.map((row) =>
        row.role === command.role ? previewRow(row, command.selection) : row
      ),
    };
    if (command.action === 'save') {
      if (next.rows.some((row) => !row.valid))
        throw new SelectionResponseError(422, 'INVALID_SELECTION');
      next.revision = String(Number(current.revision) + 1);
      store.current[kind] = next;
      setCounts((n) => ({ ...n, writes: n.writes + 1 }));
      setRevision(Number(next.revision));
    }
    return structuredClone({
      ...next,
      ...(command.action === 'preview' && kind === 'mission'
        ? { previewToken: 'a'.repeat(64) }
        : {}),
    });
  }, []);
  useEffect(() => {
    const restore = () =>
      setPage(new URLSearchParams(window.location.search).get('view') || 'mission');
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  function navigate(next: string) {
    window.history.pushState({ view: next }, '', '?view=' + next);
    setPage(next);
  }
  const target: SelectionTarget =
    page === 'reasoning'
      ? { kind: 'reasoning' }
      : { kind: 'mission', missionId: page === 'readonly' ? 'MSN-READONLY' : 'MSN-FIXTURE' };
  const initial =
    page === 'reasoning'
      ? reasoningInitial
      : page === 'readonly'
        ? readonlyInitial
        : missionInitial;
  return (
    <KbI18nProvider locale={locale} messages={operatorUiMessages(locale)}>
      <header className="operator-card">
        <h1>Synthetic selection settings fixture</h1>
        <p>No production credentials, providers or stores are used.</p>
        <nav className="operator-selection__actions" aria-label="Fixture navigation">
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() => navigate('mission')}
          >
            Mission fixture
          </button>
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() => navigate('reasoning')}
          >
            Reasoning fixture
          </button>
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() => navigate('readonly')}
          >
            Read-only fixture
          </button>
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() => setDark((value) => !value)}
          >
            Toggle theme
          </button>
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() =>
              setLocale((value) => pickByLocale<OperatorLocale>(value, { en: 'ja', ja: 'en' }))
            }
          >
            Toggle language
          </button>
          <button
            className="kb-btn kb-btn--secondary"
            type="button"
            onClick={() => {
              const current = store.current[target.kind];
              current.revision = String(Number(current.revision) + 1);
              setRevision(Number(current.revision));
            }}
          >
            Simulate concurrent change
          </button>
        </nav>
        <output aria-label="Fixture request counters">
          Reads: {counts.reads} · Previews: {counts.previews} · Save requests: {counts.saves} ·
          Writes: {counts.writes} · Rejected: {counts.rejected} · Server revision: {revision}
        </output>
      </header>
      <SelectionSettings target={target} initial={initial} locale={locale} transport={transport} />
    </KbI18nProvider>
  );
}
