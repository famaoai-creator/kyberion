'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, FrontDeskMessageKey } from '../../../lib/i18n';
import type {
  RecordingConsent,
  RecordingConsentSource,
  RecordingObservationKind,
} from '../../../lib/recording-consent-types';
import type { UseRecordingConsentResult } from '../../../lib/use-recording-consent';

/** WI-15 「設定 › PC 操作の記録」 pane — extracted from settings/page.tsx;
 * all state and fetch/mutate handlers live in `useRecordingConsent`
 * (same posture as `useTrainingAssignments`), so this component is
 * render-only. Any signed-in member manages only their own consent and
 * observation summaries — the server, never this component, resolves who
 * "own" means. */

const SOURCE_LABEL_KEYS: Record<RecordingConsentSource, FrontDeskMessageKey> = {
  desktop_recording: 'settings_recording_source_desktop_recording',
  browser_recording: 'settings_recording_source_browser_recording',
};

const KIND_LABEL_KEYS: Record<RecordingObservationKind, FrontDeskMessageKey> = {
  active_window: 'settings_recording_kind_active_window',
  browser_tabs: 'settings_recording_kind_browser_tabs',
  focused_input: 'settings_recording_kind_focused_input',
};

type ConsentStatus = 'active' | 'expired' | 'revoked';

const CONSENT_STATUS_KEYS: Record<ConsentStatus, FrontDeskMessageKey> = {
  active: 'settings_recording_consent_status_active',
  expired: 'settings_recording_consent_status_expired',
  revoked: 'settings_recording_consent_status_revoked',
};

function consentStatus(consent: RecordingConsent): ConsentStatus {
  if (consent.revoked_at) return 'revoked';
  return Date.parse(consent.expires_at) > Date.now() ? 'active' : 'expired';
}

export type RecordingConsentSectionProps = UseRecordingConsentResult & {
  locale: ConciergeLocale;
  sectionRef: (element: HTMLElement | null) => void;
};

export function RecordingConsentSection({
  locale,
  recordingStanding,
  recordingObservations,
  recordingBusy,
  grantForm,
  setGrantForm,
  attachSelection,
  setAttachEntryId,
  submitRecordingGrant,
  revokeRecordingConsent,
  confirmRecordingSummary,
  discardRecordingSummary,
  attachRecordingSummary,
  sectionRef,
}: RecordingConsentSectionProps) {
  const availableSources = recordingStanding?.sources ?? [];
  const availableKinds = recordingStanding?.observation_kinds ?? [];
  const maxDays = recordingStanding?.max_days ?? 90;
  const days = Number(grantForm.days);
  const grantDisabled =
    recordingBusy ||
    grantForm.sources.length === 0 ||
    grantForm.observationKinds.length === 0 ||
    !grantForm.purpose.trim() ||
    !Number.isFinite(days) ||
    days <= 0 ||
    days > maxDays;
  const pendingSummaries = (recordingObservations?.summaries ?? []).filter(
    (summary) => summary.status === 'pending_review'
  );
  const candidateEntries = recordingObservations?.candidateEntries ?? [];

  return (
    <section
      className="pane"
      id="settings-recording"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_recording', locale)}
    >
      <h2>{frontDeskText('settings_nav_recording', locale)}</h2>
      <p className="settings-card-lead">{frontDeskText('settings_recording_lead', locale)}</p>

      <h3 className="pane-subheading">{frontDeskText('settings_recording_grant_title', locale)}</h3>
      <fieldset className="field-group">
        <legend>{frontDeskText('settings_recording_sources_label', locale)}</legend>
        {availableSources.map((source) => (
          <label className="checkbox-label" key={source}>
            <input
              type="checkbox"
              checked={grantForm.sources.includes(source)}
              onChange={(event) =>
                setGrantForm((current) => ({
                  ...current,
                  sources: event.target.checked
                    ? [...current.sources, source]
                    : current.sources.filter((entry) => entry !== source),
                }))
              }
            />
            <span>{frontDeskText(SOURCE_LABEL_KEYS[source], locale)}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field-group">
        <legend>{frontDeskText('settings_recording_kinds_label', locale)}</legend>
        {availableKinds.map((kind) => (
          <label className="checkbox-label" key={kind}>
            <input
              type="checkbox"
              checked={grantForm.observationKinds.includes(kind)}
              onChange={(event) =>
                setGrantForm((current) => ({
                  ...current,
                  observationKinds: event.target.checked
                    ? [...current.observationKinds, kind]
                    : current.observationKinds.filter((entry) => entry !== kind),
                }))
              }
            />
            <span>{frontDeskText(KIND_LABEL_KEYS[kind], locale)}</span>
          </label>
        ))}
      </fieldset>
      <label className="field-label">
        {frontDeskText('settings_recording_purpose_label', locale)}
        <input
          value={grantForm.purpose}
          placeholder={frontDeskText('settings_recording_purpose_placeholder', locale)}
          onChange={(event) =>
            setGrantForm((current) => ({ ...current, purpose: event.target.value }))
          }
        />
      </label>
      <label className="field-label">
        {frontDeskText('settings_recording_days_label', locale)}
        <input
          type="number"
          min={1}
          max={maxDays}
          value={grantForm.days}
          onChange={(event) =>
            setGrantForm((current) => ({ ...current, days: event.target.value }))
          }
        />
      </label>
      <p className="item-meta">
        {frontDeskText('settings_recording_days_hint', locale, { max: maxDays })}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="action-button"
          disabled={grantDisabled}
          onClick={() => void submitRecordingGrant()}
        >
          {frontDeskText('settings_recording_grant_submit', locale)}
        </button>
      </div>

      <h3 className="pane-subheading">
        {frontDeskText('settings_recording_consents_title', locale)}
      </h3>
      {!recordingStanding || recordingStanding.consents.length === 0 ? (
        <p className="pane-empty">{frontDeskText('settings_recording_consents_empty', locale)}</p>
      ) : (
        recordingStanding.consents.map((consent) => {
          const status = consentStatus(consent);
          return (
            <div className="item-card" key={consent.consent_id}>
              <p className="item-title">
                {consent.sources
                  .map((source) => frontDeskText(SOURCE_LABEL_KEYS[source], locale))
                  .join(', ')}
                <span className={`status-chip${status === 'active' ? ' ok' : ' attention'}`}>
                  {frontDeskText(CONSENT_STATUS_KEYS[status], locale)}
                </span>
              </p>
              <p className="item-meta">
                {consent.observation_kinds
                  .map((kind) => frontDeskText(KIND_LABEL_KEYS[kind], locale))
                  .join(', ')}
              </p>
              <p className="item-meta">
                {frontDeskText('settings_recording_consent_expires', locale, {
                  date: consent.expires_at,
                })}
              </p>
              {status === 'active' ? (
                <div className="button-row">
                  <button
                    type="button"
                    className="action-button secondary"
                    disabled={recordingBusy}
                    onClick={() => void revokeRecordingConsent(consent.consent_id)}
                  >
                    {frontDeskText('settings_recording_consent_revoke', locale)}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}

      <h3 className="pane-subheading">
        {frontDeskText('settings_recording_pending_title', locale)}
      </h3>
      {pendingSummaries.length === 0 ? (
        <p className="pane-empty">{frontDeskText('settings_recording_pending_empty', locale)}</p>
      ) : (
        pendingSummaries.map((summary) => (
          <div className="item-card" key={summary.summary_id}>
            <p className="item-title">{summary.digest}</p>
            <div className="button-row">
              <button
                type="button"
                className="action-button"
                disabled={recordingBusy}
                onClick={() => void confirmRecordingSummary(summary.summary_id)}
              >
                {frontDeskText('settings_recording_pending_confirm', locale)}
              </button>
              <button
                type="button"
                className="action-button secondary"
                disabled={recordingBusy}
                onClick={() => void discardRecordingSummary(summary.summary_id)}
              >
                {frontDeskText('settings_recording_pending_discard', locale)}
              </button>
            </div>
            {candidateEntries.length === 0 ? (
              <p className="item-meta">
                {frontDeskText('settings_recording_pending_attach_none', locale)}
              </p>
            ) : (
              <label className="field-label">
                {frontDeskText('settings_recording_pending_attach_label', locale)}
                <select
                  value={attachSelection[summary.summary_id] ?? ''}
                  onChange={(event) => setAttachEntryId(summary.summary_id, event.target.value)}
                >
                  <option value="">
                    {frontDeskText('settings_recording_pending_attach_placeholder', locale)}
                  </option>
                  {candidateEntries.map((entry) => (
                    <option key={entry.entry_id} value={entry.entry_id}>
                      {entry.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="action-button secondary"
                  disabled={recordingBusy || !attachSelection[summary.summary_id]}
                  onClick={() => void attachRecordingSummary(summary.summary_id)}
                >
                  {frontDeskText('settings_recording_pending_attach_submit', locale)}
                </button>
              </label>
            )}
          </div>
        ))
      )}
    </section>
  );
}
