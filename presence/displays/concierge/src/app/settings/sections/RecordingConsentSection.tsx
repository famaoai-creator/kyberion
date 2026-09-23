'use client';

import * as React from 'react';
import {
  Button,
  Checkbox,
  EmptyState,
  Select,
  SettingRow,
  SettingsGroup,
  StatusPill,
  TextField,
} from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, FrontDeskMessageKey } from '../../../lib/i18n';
import type {
  RecordingConsent,
  RecordingConsentSource,
  RecordingObservationKind,
} from '../../../lib/recording-consent-types';
import type { UseRecordingConsentResult } from '../../../lib/use-recording-consent';
import { FormScope, asText } from './form-scope';

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
  /**
   * WI-18 (user decision 2026-09-22): only `attach` (it mutates a shared
   * work-inventory entry) needs an owner/approver viewer — grant, revoke,
   * confirm, and discard are self-service for every member, including a
   * readonly `viewer`. Derived from `/api/me`'s `viewing.role` on the
   * settings page (`meViewing?.role !== 'viewer'`), the same signal that
   * decides `FrontDeskHumanRole` -> `ChronosAccessRole` server-side
   * (`front-desk-roles.ts`). Defaults to `true` (unrestricted) whenever that
   * role isn't positively known yet, matching this pane's existing
   * degrade-gracefully posture.
   */
  canAttachToWorkItem: boolean;
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
  canAttachToWorkItem,
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
    !Number.isInteger(days) ||
    days <= 0 ||
    days > maxDays;
  const pendingSummaries = (recordingObservations?.summaries ?? []).filter(
    (summary) => summary.status === 'pending_review'
  );
  const candidateEntries = recordingObservations?.candidateEntries ?? [];

  const toggle = <T extends string>(list: T[], item: T, on: boolean): T[] =>
    on ? (list.includes(item) ? list : [...list, item]) : list.filter((entry) => entry !== item);
  const fields: Record<string, (value: unknown) => void> = {
    'recording.purpose': (value) =>
      setGrantForm((current) => ({ ...current, purpose: asText(value) })),
    'recording.days': (value) => setGrantForm((current) => ({ ...current, days: asText(value) })),
  };
  for (const source of availableSources) {
    fields[`recording.source.${source}`] = (value) =>
      setGrantForm((current) => ({
        ...current,
        sources: toggle(current.sources, source, value === true),
      }));
  }
  for (const kind of availableKinds) {
    fields[`recording.kind.${kind}`] = (value) =>
      setGrantForm((current) => ({
        ...current,
        observationKinds: toggle(current.observationKinds, kind, value === true),
      }));
  }
  for (const summary of pendingSummaries) {
    fields[`recording.attach.${summary.summary_id}`] = (value) =>
      setAttachEntryId(summary.summary_id, asText(value));
  }

  return (
    <div
      className="settings-section"
      id="settings-recording"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_recording', locale)}
    >
      <FormScope fields={fields}>
        <SettingsGroup
          id="settings-recording-grant"
          title={frontDeskText('settings_nav_recording', locale)}
          description={frontDeskText('settings_recording_lead', locale)}
        >
          <div className="settings-row-block">
            <p className="kb-text kb-text--title">
              {frontDeskText('settings_recording_grant_title', locale)}
            </p>
          </div>
          <SettingRow label={frontDeskText('settings_recording_sources_label', locale)}>
            <div className="settings-check-list">
              {availableSources.map((source) => (
                <Checkbox
                  key={source}
                  id={`recording-source-${source}`}
                  name={`recording.source.${source}`}
                  label={frontDeskText(SOURCE_LABEL_KEYS[source], locale)}
                  value={grantForm.sources.includes(source)}
                />
              ))}
            </div>
          </SettingRow>
          <SettingRow label={frontDeskText('settings_recording_kinds_label', locale)}>
            <div className="settings-check-list">
              {availableKinds.map((kind) => (
                <Checkbox
                  key={kind}
                  id={`recording-kind-${kind}`}
                  name={`recording.kind.${kind}`}
                  label={frontDeskText(KIND_LABEL_KEYS[kind], locale)}
                  value={grantForm.observationKinds.includes(kind)}
                />
              ))}
            </div>
          </SettingRow>
          <SettingRow label={frontDeskText('settings_recording_purpose_label', locale)}>
            <TextField
              id="recording-purpose"
              name="recording.purpose"
              label={frontDeskText('settings_recording_purpose_label', locale)}
              hide_label
              value={grantForm.purpose}
              placeholder={frontDeskText('settings_recording_purpose_placeholder', locale)}
            />
          </SettingRow>
          <SettingRow
            label={frontDeskText('settings_recording_days_label', locale)}
            description={frontDeskText('settings_recording_days_hint', locale, { max: maxDays })}
          >
            <TextField
              id="recording-days"
              name="recording.days"
              label={frontDeskText('settings_recording_days_label', locale)}
              hide_label
              type="number"
              min={1}
              max={maxDays}
              value={grantForm.days}
            />
          </SettingRow>
          <div className="settings-row-actions">
            <Button
              label={frontDeskText('settings_recording_grant_submit', locale)}
              variant="primary"
              disabled={grantDisabled}
              onClick={() => void submitRecordingGrant()}
            />
          </div>
        </SettingsGroup>

        <SettingsGroup
          id="settings-recording-consents"
          title={frontDeskText('settings_recording_consents_title', locale)}
        >
          {!recordingStanding || recordingStanding.consents.length === 0 ? (
            <div className="settings-row-block">
              <EmptyState title={frontDeskText('settings_recording_consents_empty', locale)} />
            </div>
          ) : (
            recordingStanding.consents.map((consent) => {
              const status = consentStatus(consent);
              return (
                <SettingRow
                  key={consent.consent_id}
                  label={consent.sources
                    .map((source) => frontDeskText(SOURCE_LABEL_KEYS[source], locale))
                    .join(', ')}
                  description={`${consent.observation_kinds
                    .map((kind) => frontDeskText(KIND_LABEL_KEYS[kind], locale))
                    .join(', ')} · ${frontDeskText('settings_recording_consent_expires', locale, {
                    date: consent.expires_at,
                  })}`}
                >
                  <div className="settings-inline-actions">
                    <StatusPill
                      status={
                        status === 'active' ? 'active' : status === 'expired' ? 'stale' : 'archived'
                      }
                      label={frontDeskText(CONSENT_STATUS_KEYS[status], locale)}
                    />
                    {status === 'active' ? (
                      <Button
                        label={frontDeskText('settings_recording_consent_revoke', locale)}
                        variant="secondary"
                        disabled={recordingBusy}
                        onClick={() => void revokeRecordingConsent(consent.consent_id)}
                      />
                    ) : null}
                  </div>
                </SettingRow>
              );
            })
          )}
        </SettingsGroup>

        <SettingsGroup
          id="settings-recording-pending"
          title={frontDeskText('settings_recording_pending_title', locale)}
        >
          {pendingSummaries.length === 0 ? (
            <div className="settings-row-block">
              <EmptyState title={frontDeskText('settings_recording_pending_empty', locale)} />
            </div>
          ) : (
            pendingSummaries.map((summary) => (
              <div className="settings-row-group" key={summary.summary_id}>
                <SettingRow label={summary.digest}>
                  <div className="settings-inline-actions">
                    <Button
                      label={frontDeskText('settings_recording_pending_confirm', locale)}
                      variant="primary"
                      disabled={recordingBusy}
                      onClick={() => void confirmRecordingSummary(summary.summary_id)}
                    />
                    <Button
                      label={frontDeskText('settings_recording_pending_discard', locale)}
                      variant="secondary"
                      disabled={recordingBusy}
                      onClick={() => void discardRecordingSummary(summary.summary_id)}
                    />
                  </div>
                </SettingRow>
                {!canAttachToWorkItem ? (
                  <div className="settings-row-block">
                    <p className="kb-text kb-text--muted">
                      {frontDeskText('settings_recording_pending_attach_restricted', locale)}
                    </p>
                  </div>
                ) : candidateEntries.length === 0 ? (
                  <div className="settings-row-block">
                    <p className="kb-text kb-text--muted">
                      {frontDeskText('settings_recording_pending_attach_none', locale)}
                    </p>
                  </div>
                ) : (
                  <SettingRow
                    label={frontDeskText('settings_recording_pending_attach_label', locale)}
                  >
                    <div className="settings-inline-actions">
                      <Select
                        id={`recording-attach-${summary.summary_id}`}
                        name={`recording.attach.${summary.summary_id}`}
                        label={frontDeskText('settings_recording_pending_attach_label', locale)}
                        hide_label
                        value={attachSelection[summary.summary_id] ?? ''}
                        placeholder={frontDeskText(
                          'settings_recording_pending_attach_placeholder',
                          locale
                        )}
                        options={candidateEntries.map((entry) => ({
                          value: entry.entry_id,
                          label: entry.title,
                        }))}
                      />
                      <Button
                        label={frontDeskText('settings_recording_pending_attach_submit', locale)}
                        variant="secondary"
                        disabled={recordingBusy || !attachSelection[summary.summary_id]}
                        onClick={() => void attachRecordingSummary(summary.summary_id)}
                      />
                    </div>
                  </SettingRow>
                )}
              </div>
            ))
          )}
        </SettingsGroup>
      </FormScope>
    </div>
  );
}
