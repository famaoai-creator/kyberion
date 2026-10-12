'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Section, StatusPill } from '@agent/shared-ui';
import { operatorTranslator, type OperatorLocale } from '@/lib/i18n';
import {
  SelectionRequestGate,
  SelectionResponseError,
  type SelectionRequest,
  type SelectionRow,
  type SelectionSnapshot,
  type SelectionTarget,
  type SelectionTransport,
} from '@/lib/selection-contract';
import { requestSelection } from '@/lib/selection-client';

export interface SelectionSettingsProps {
  target: SelectionTarget;
  initial: SelectionSnapshot;
  locale: OperatorLocale;
  /** Dependency injection for the isolated browser fixture; production uses the fixed local transport. */
  transport?: SelectionTransport;
}

export default function SelectionSettings({
  target,
  initial,
  locale,
  transport = requestSelection,
}: SelectionSettingsProps) {
  const t = operatorTranslator(locale);
  const id = useId();
  const statusId = id + '-status';
  const targetKey = target.kind + ':' + (target.missionId ?? '');
  const gate = useRef(new SelectionRequestGate());
  const [snapshot, setSnapshot] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SelectionRequest>({ mode: 'auto' });
  const [preview, setPreview] = useState<SelectionRow | null>(null);
  const [previewToken, setPreviewToken] = useState<string | undefined>();
  const [busy, setBusy] = useState<'preview' | 'save' | 'reload' | null>(null);
  const [notice, setNotice] = useState<'saved' | 'error' | 'conflict' | null>(null);
  const activeTarget = useRef(targetKey);
  activeTarget.current = targetKey;

  useEffect(() => {
    gate.current.cancel();
    setSnapshot(initial);
    setEditing(null);
    setPreview(null);
    setPreviewToken(undefined);
    setBusy(null);
    setNotice(null);
    return () => gate.current.cancel();
  }, [targetKey, initial]);

  const reload = useCallback(async () => {
    gate.current.cancel();
    const request = gate.current.begin();
    if (!request) return;
    const key = targetKey;
    setBusy('reload');
    setEditing(null);
    setPreview(null);
    setPreviewToken(undefined);
    setNotice(null);
    try {
      const value = await transport(target, null, request.signal);
      if (gate.current.accepts(request.version) && activeTarget.current === key) setSnapshot(value);
    } catch (error) {
      if (
        gate.current.accepts(request.version) &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        setNotice('error');
    } finally {
      if (gate.current.accepts(request.version)) {
        gate.current.complete(request.version);
        setBusy(null);
      }
    }
  }, [targetKey, target.kind, target.missionId, transport]);

  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    void reload(); // Revalidate on each mounted target, including client Back/Forward navigation.
    window.addEventListener('popstate', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('popstate', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, [reload]);

  function cancel() {
    if (busy === 'save') return; // An accepted save cannot be undone by aborting its HTTP response.
    gate.current.cancel();
    setBusy(null);
    setEditing(null);
    setPreview(null);
    setPreviewToken(undefined);
    setNotice(null);
  }
  function change(key: keyof SelectionRequest, value: string) {
    setPreview(null);
    setPreviewToken(undefined);
    setNotice(null);
    setDraft((previous) => {
      if (key === 'mode' && value === 'auto') return { mode: 'auto' };
      const next = { ...previous, [key]: value };
      if (!value) delete next[key];
      return next as SelectionRequest;
    });
  }
  async function run(action: 'preview' | 'save') {
    if (
      !editing ||
      !snapshot.canEdit ||
      notice === 'conflict' ||
      (action === 'save' && (!preview?.valid || (target.kind === 'mission' && !previewToken)))
    )
      return;
    const request = gate.current.begin();
    if (!request) return;
    const key = targetKey;
    setBusy(action);
    setNotice(null);
    try {
      const value = await transport(
        target,
        {
          action,
          role: editing,
          selection: draft,
          expectedRevision: snapshot.revision,
          ...(action === 'save' && target.kind === 'mission'
            ? { expectedPreviewToken: previewToken }
            : {}),
        },
        request.signal
      );
      if (!gate.current.accepts(request.version) || activeTarget.current !== key) return;
      if (action === 'preview') {
        if (value.revision !== snapshot.revision) {
          setNotice('conflict');
          setPreview(null);
          setPreviewToken(undefined);
        } else {
          setPreview(value.rows.find((row) => row.role === editing) ?? null);
          setPreviewToken(value.previewToken);
        }
      } else {
        setSnapshot(value);
        setEditing(null);
        setPreview(null);
        setPreviewToken(undefined);
        setNotice('saved');
      }
    } catch (error) {
      if (!gate.current.accepts(request.version)) return;
      if (error instanceof SelectionResponseError && error.status === 409) {
        setNotice('conflict');
        setPreview(null);
        setPreviewToken(undefined);
      } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice('error');
        setPreview(null);
        setPreviewToken(undefined);
      }
    } finally {
      if (gate.current.accepts(request.version)) {
        gate.current.complete(request.version);
        setBusy(null);
      }
    }
  }
  const modeLabel = (mode: SelectionRequest['mode']) =>
    t(
      mode === 'auto'
        ? 'selection_auto'
        : mode === 'preferred'
          ? 'selection_preferred'
          : 'selection_fixed'
    );
  function describe(selection: Partial<SelectionRequest> | null) {
    if (!selection) return t('selection_none');
    const parts = [
      selection.mode ? modeLabel(selection.mode) : '',
      selection.agent_id ? t('selection_agent') + ': ' + selection.agent_id : '',
      selection.runtime_mode ? t('selection_runtime') + ': ' + selection.runtime_mode : '',
      selection.provider ? t('selection_provider') + ': ' + selection.provider : '',
      selection.model
        ? t('selection_model') + ': ' + selection.model
        : selection.mode && selection.mode !== 'auto'
          ? t('selection_model') + ': ' + t('selection_none')
          : '',
      selection.profile ? t('selection_profile') + ': ' + selection.profile : '',
    ].filter(Boolean);
    return parts.join(' · ') || t('selection_none');
  }
  function reasonIds(row: SelectionRow, baseId: string): string[] {
    return [
      baseId + '-reason',
      ...(row.details?.length ? [baseId + '-details'] : []),
      ...(row.eligibility?.eligible === false ? [baseId + '-eligibility'] : []),
    ];
  }
  function resolution(row: SelectionRow, baseId: string, proposed = false) {
    return (
      <div
        className="operator-selection__resolution"
        aria-label={t(proposed ? 'selection_proposed' : 'selection_current')}
      >
        <dl>
          <div>
            <dt>{t('selection_requested')}</dt>
            <dd>{describe(row.requested)}</dd>
          </div>
          <div>
            <dt>{t('selection_effective')}</dt>
            <dd>{describe(row.effective)}</dd>
          </div>
          <div>
            <dt>{t('selection_source')}</dt>
            <dd>{row.source}</dd>
          </div>
          <div>
            <dt>{t('selection_reason')}</dt>
            <dd id={baseId + '-reason'}>{row.reason}</dd>
          </div>
        </dl>
        {row.details?.length ? (
          <ul className="operator-muted" id={baseId + '-details'}>
            {row.details.map((detail, index) => (
              <li key={detail.target + ':' + index}>
                {t('selection_profile')}: {detail.target} · {detail.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {row.eligibility?.eligible === false ? (
          <div role="status">
            <StatusPill status="error" label={t('selection_blocked')} />
            <p id={baseId + '-eligibility'}>{row.eligibility.reason}</p>
          </div>
        ) : row.conflict ? (
          <StatusPill status="error" label={t('selection_policy_conflict')} />
        ) : !row.valid ? (
          <StatusPill status="error" label={t('selection_blocked')} />
        ) : row.fallback ? (
          <StatusPill status="fallback" label={t('selection_fallback')} />
        ) : null}
      </div>
    );
  }
  return (
    <Section
      title={t(target.kind === 'mission' ? 'selection_actor_title' : 'selection_reasoning_title')}
      description={t(
        target.kind === 'mission'
          ? 'selection_actor_description'
          : 'selection_reasoning_description'
      )}
    >
      {target.kind === 'reasoning' ? (
        <p className="operator-muted">{t('selection_reasoning_runtime_notice')}</p>
      ) : null}
      {!snapshot.canEdit ? <p className="operator-muted">{t('selection_readonly')}</p> : null}
      <div id={statusId} role="status" aria-live="polite" aria-atomic="true">
        {busy
          ? t('selection_busy')
          : notice
            ? t(
                notice === 'saved'
                  ? 'selection_saved'
                  : notice === 'conflict'
                    ? 'selection_conflict'
                    : 'selection_error'
              )
            : ''}
      </div>
      {(notice === 'conflict' || notice === 'error') && !busy ? (
        <button
          className="kb-btn kb-btn--secondary"
          type="button"
          aria-describedby={statusId}
          onClick={() => void reload()}
        >
          {t('selection_reload')}
        </button>
      ) : null}
      {snapshot.rows.length === 0 ? <p>{t('selection_empty')}</p> : null}
      <div className="operator-selection">
        {snapshot.rows.map((row) => {
          const fieldId = id + '-' + encodeURIComponent(row.role);
          const selected = editing === row.role;
          const currentReasonIds = reasonIds(row, fieldId + '-current');
          const currentWarningIds =
            !row.valid || row.eligibility?.eligible === false ? currentReasonIds : [];
          const editorErrorIds = [
            ...(notice === 'error' || notice === 'conflict' ? [statusId] : []),
            ...(preview &&
            (!preview.valid || preview.conflict || preview.eligibility?.eligible === false)
              ? reasonIds(preview, fieldId + '-preview')
              : []),
          ];
          const editorDescription = [
            fieldId + '-preview-note',
            ...currentWarningIds,
            ...editorErrorIds,
          ].join(' ');
          return (
            <article
              className="operator-card"
              key={row.role}
              aria-labelledby={fieldId + '-title'}
              aria-describedby={currentReasonIds.join(' ')}
            >
              <div className="operator-card__header">
                <h3 className="operator-card__title" id={fieldId + '-title'}>
                  {row.role}
                </h3>
                {snapshot.canEdit && !selected ? (
                  <button
                    type="button"
                    className="kb-btn kb-btn--secondary"
                    aria-describedby={currentWarningIds.join(' ') || undefined}
                    disabled={Boolean(busy) || editing !== null || notice === 'conflict'}
                    onClick={() => {
                      setEditing(row.role);
                      setDraft(row.requested ? { ...row.requested } : { mode: 'auto' });
                      setPreview(null);
                      setPreviewToken(undefined);
                      setNotice(null);
                    }}
                  >
                    {t('selection_edit')}
                  </button>
                ) : null}
              </div>
              {resolution(row, fieldId + '-current')}
              {selected ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('preview');
                  }}
                >
                  <fieldset
                    disabled={Boolean(busy) || notice === 'conflict'}
                    className="operator-selection__fields"
                    aria-describedby={editorDescription}
                    aria-invalid={editorErrorIds.length ? true : undefined}
                    aria-errormessage={editorErrorIds.join(' ') || undefined}
                  >
                    <legend className="operator-muted">{t('selection_fixed_help')}</legend>
                    <label htmlFor={fieldId + '-mode'}>
                      {t('selection_mode')}
                      <select
                        id={fieldId + '-mode'}
                        value={draft.mode}
                        onChange={(event) => change('mode', event.target.value)}
                      >
                        {(['auto', 'preferred', 'fixed'] as const).map((mode) => (
                          <option value={mode} key={mode}>
                            {modeLabel(mode)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {draft.mode !== 'auto' ? (
                      <>
                        <label htmlFor={fieldId + '-identity'}>
                          {t(target.kind === 'mission' ? 'selection_agent' : 'selection_runtime')}
                          <select
                            id={fieldId + '-identity'}
                            value={
                              (target.kind === 'mission' ? draft.agent_id : draft.runtime_mode) ??
                              ''
                            }
                            required={target.kind === 'reasoning'}
                            onChange={(event) =>
                              change(
                                target.kind === 'mission' ? 'agent_id' : 'runtime_mode',
                                event.target.value
                              )
                            }
                          >
                            <option value="">{t('selection_none')}</option>
                            {row.choices.map((choice) => (
                              <option key={choice.value} value={choice.value}>
                                {choice.value}
                                {choice.eligible === false ? ' (' + choice.reason + ')' : ''}
                              </option>
                            ))}
                            {(target.kind === 'mission' ? draft.agent_id : draft.runtime_mode) &&
                            !row.choices.some(
                              (choice) =>
                                choice.value ===
                                (target.kind === 'mission' ? draft.agent_id : draft.runtime_mode)
                            ) ? (
                              <option
                                value={
                                  (target.kind === 'mission' ? draft.agent_id : draft.runtime_mode)!
                                }
                              >
                                {target.kind === 'mission' ? draft.agent_id : draft.runtime_mode}
                              </option>
                            ) : null}
                          </select>
                        </label>
                        <datalist id={fieldId + '-providers'}>
                          {[
                            ...new Set(
                              row.choices.map((choice) => choice.provider).filter(Boolean)
                            ),
                          ].map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                        <datalist id={fieldId + '-models'}>
                          {[
                            ...new Set(
                              row.choices
                                .filter(
                                  (choice) =>
                                    target.kind === 'mission' ||
                                    !draft.runtime_mode ||
                                    choice.value === draft.runtime_mode
                                )
                                .flatMap(
                                  (choice) => choice.models ?? (choice.model ? [choice.model] : [])
                                )
                            ),
                          ].map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                        <datalist id={fieldId + '-profiles'}>
                          {[
                            ...new Set(
                              row.choices
                                .filter(
                                  (choice) =>
                                    !draft.runtime_mode || choice.value === draft.runtime_mode
                                )
                                .flatMap((choice) => choice.profiles ?? [])
                            ),
                          ].map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                        <label htmlFor={fieldId + '-provider'}>
                          {t('selection_provider')}
                          <input
                            id={fieldId + '-provider'}
                            list={fieldId + '-providers'}
                            value={draft.provider ?? ''}
                            onChange={(event) => change('provider', event.target.value)}
                            maxLength={160}
                            autoComplete="off"
                            placeholder={t('selection_none')}
                          />
                        </label>
                        <label htmlFor={fieldId + '-model'}>
                          {t('selection_model')}
                          <input
                            id={fieldId + '-model'}
                            list={fieldId + '-models'}
                            value={draft.model ?? ''}
                            onChange={(event) => change('model', event.target.value)}
                            maxLength={160}
                            autoComplete="off"
                            placeholder={t('selection_none')}
                          />
                        </label>
                        {target.kind === 'reasoning' ? (
                          <label htmlFor={fieldId + '-profile'}>
                            {t('selection_profile')}
                            <input
                              id={fieldId + '-profile'}
                              list={fieldId + '-profiles'}
                              value={draft.profile ?? ''}
                              onChange={(event) => change('profile', event.target.value)}
                              maxLength={160}
                              autoComplete="off"
                              placeholder={t('selection_none')}
                            />
                          </label>
                        ) : null}
                      </>
                    ) : null}
                  </fieldset>
                  <p className="operator-muted" id={fieldId + '-preview-note'}>
                    {t('selection_preview_notice')}
                  </p>
                  {preview ? (
                    <div aria-live="polite">
                      <h4>{t('selection_proposed')}</h4>
                      {resolution(preview, fieldId + '-preview', true)}
                    </div>
                  ) : (
                    <p className="operator-muted">{t('selection_preview_required')}</p>
                  )}
                  <div className="operator-selection__actions">
                    <button
                      className="kb-btn kb-btn--secondary"
                      type="submit"
                      disabled={Boolean(busy) || notice === 'conflict'}
                      aria-describedby={editorDescription}
                    >
                      {t('selection_preview')}
                    </button>
                    <button
                      className="kb-btn kb-btn--primary"
                      type="button"
                      disabled={
                        Boolean(busy) ||
                        !preview?.valid ||
                        (target.kind === 'mission' && !previewToken) ||
                        notice === 'conflict'
                      }
                      aria-describedby={editorDescription}
                      onClick={() => void run('save')}
                    >
                      {t('selection_save')}
                    </button>
                    <button
                      className="kb-btn kb-btn--ghost"
                      type="button"
                      disabled={busy === 'save'}
                      onClick={cancel}
                    >
                      {t('selection_cancel')}
                    </button>
                  </div>
                </form>
              ) : null}
            </article>
          );
        })}
      </div>
    </Section>
  );
}
