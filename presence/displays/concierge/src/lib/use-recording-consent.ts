'use client';

import * as React from 'react';
import { frontDeskText, type ConciergeLocale } from './i18n';
import type { Notice } from './settings-types';
import {
  parseRecordingConsentStandingResponse,
  parseRecordingObservationsResponse,
  type RecordingConsentSource,
  type RecordingConsentStanding,
  type RecordingObservationKind,
  type RecordingObservationsView,
} from './recording-consent-types';

/**
 * WI-15 「設定 › PC 操作の記録」: the signed-in member's own consent standing
 * and pending observation summaries (`/api/work-inventory/consent`,
 * `/api/work-inventory/observations`). Split out of settings/page.tsx into
 * its own hook (same posture as use-training-assignments.ts) so the page
 * stays under the KP max-file-lines gate. Every write always acts on the
 * server-resolved viewer's own member — this hook never sends a member id.
 */
export interface RecordingGrantForm {
  sources: RecordingConsentSource[];
  observationKinds: RecordingObservationKind[];
  purpose: string;
  days: string;
}

const EMPTY_GRANT_FORM: RecordingGrantForm = {
  sources: [],
  observationKinds: [],
  purpose: '',
  days: '30',
};

export interface UseRecordingConsentResult {
  recordingStanding: RecordingConsentStanding | null;
  recordingObservations: RecordingObservationsView | null;
  recordingBusy: boolean;
  grantForm: RecordingGrantForm;
  setGrantForm: React.Dispatch<React.SetStateAction<RecordingGrantForm>>;
  attachSelection: Record<string, string>;
  setAttachEntryId: (summaryId: string, entryId: string) => void;
  refreshRecordingConsent: () => Promise<void>;
  refreshRecordingObservations: () => Promise<void>;
  submitRecordingGrant: () => Promise<void>;
  revokeRecordingConsent: (consentId: string) => Promise<void>;
  confirmRecordingSummary: (summaryId: string) => Promise<void>;
  discardRecordingSummary: (summaryId: string) => Promise<void>;
  attachRecordingSummary: (summaryId: string) => Promise<void>;
}

export function useRecordingConsent(
  locale: ConciergeLocale,
  setNotice: (notice: Notice) => void
): UseRecordingConsentResult {
  const [recordingStanding, setRecordingStanding] = React.useState<RecordingConsentStanding | null>(
    null
  );
  const [recordingObservations, setRecordingObservations] =
    React.useState<RecordingObservationsView | null>(null);
  const [recordingBusy, setRecordingBusy] = React.useState(false);
  const [grantForm, setGrantForm] = React.useState<RecordingGrantForm>(EMPTY_GRANT_FORM);
  const [attachSelection, setAttachSelection] = React.useState<Record<string, string>>({});

  const refreshRecordingConsent = React.useCallback(async () => {
    try {
      const response = await fetch('/api/work-inventory/consent', { cache: 'no-store' });
      const standing = parseRecordingConsentStandingResponse(
        await response.json().catch(() => null)
      );
      if (response.ok && standing) setRecordingStanding(standing);
    } catch {
      // Recording consent is optional settings data; the page stays usable without it.
    }
  }, []);

  const refreshRecordingObservations = React.useCallback(async () => {
    try {
      const response = await fetch('/api/work-inventory/observations', { cache: 'no-store' });
      const observations = parseRecordingObservationsResponse(
        await response.json().catch(() => null)
      );
      if (response.ok && observations) setRecordingObservations(observations);
    } catch {
      // Same posture as refreshRecordingConsent above.
    }
  }, []);

  const setAttachEntryId = React.useCallback((summaryId: string, entryId: string) => {
    setAttachSelection((current) => ({ ...current, [summaryId]: entryId }));
  }, []);

  const postAction = React.useCallback(
    async (path: string, body: Record<string, unknown>): Promise<boolean> => {
      setRecordingBusy(true);
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const parsed = await response.json().catch(() => null);
        if (!response.ok || !parsed?.ok) {
          throw new Error(
            (parsed && typeof parsed.error === 'string' && parsed.error) ||
              frontDeskText('settings_recording_grant_invalid', locale)
          );
        }
        return true;
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
        return false;
      } finally {
        setRecordingBusy(false);
      }
    },
    [locale, setNotice]
  );

  const submitRecordingGrant = React.useCallback(async () => {
    const days = Number(grantForm.days);
    const ok = await postAction('/api/work-inventory/consent', {
      action: 'grant',
      sources: grantForm.sources,
      observation_kinds: grantForm.observationKinds,
      purpose: grantForm.purpose.trim(),
      days,
    });
    if (!ok) return;
    setNotice({ text: frontDeskText('settings_recording_consent_granted', locale) });
    setGrantForm((current) => ({ ...EMPTY_GRANT_FORM, days: current.days }));
    await refreshRecordingConsent();
  }, [grantForm, locale, postAction, refreshRecordingConsent, setNotice]);

  const revokeRecordingConsent = React.useCallback(
    async (consentId: string) => {
      const ok = await postAction('/api/work-inventory/consent', {
        action: 'revoke',
        consent_id: consentId,
      });
      if (!ok) return;
      setNotice({ text: frontDeskText('settings_recording_consent_revoked_notice', locale) });
      await refreshRecordingConsent();
    },
    [locale, postAction, refreshRecordingConsent, setNotice]
  );

  const confirmRecordingSummary = React.useCallback(
    async (summaryId: string) => {
      const ok = await postAction('/api/work-inventory/observations', {
        action: 'confirm',
        summary_id: summaryId,
      });
      if (!ok) return;
      setNotice({ text: frontDeskText('settings_recording_summary_confirmed', locale) });
      await refreshRecordingObservations();
    },
    [locale, postAction, refreshRecordingObservations, setNotice]
  );

  const discardRecordingSummary = React.useCallback(
    async (summaryId: string) => {
      const ok = await postAction('/api/work-inventory/observations', {
        action: 'discard',
        summary_id: summaryId,
      });
      if (!ok) return;
      setNotice({ text: frontDeskText('settings_recording_summary_discarded', locale) });
      await refreshRecordingObservations();
    },
    [locale, postAction, refreshRecordingObservations, setNotice]
  );

  const attachRecordingSummary = React.useCallback(
    async (summaryId: string) => {
      const entryId = attachSelection[summaryId];
      if (!entryId) return;
      const ok = await postAction('/api/work-inventory/observations', {
        action: 'attach',
        summary_id: summaryId,
        entry_id: entryId,
      });
      if (!ok) return;
      setNotice({ text: frontDeskText('settings_recording_summary_attached', locale) });
      setAttachSelection((current) => {
        const next = { ...current };
        delete next[summaryId];
        return next;
      });
      await refreshRecordingObservations();
    },
    [attachSelection, locale, postAction, refreshRecordingObservations, setNotice]
  );

  return {
    recordingStanding,
    recordingObservations,
    recordingBusy,
    grantForm,
    setGrantForm,
    attachSelection,
    setAttachEntryId,
    refreshRecordingConsent,
    refreshRecordingObservations,
    submitRecordingGrant,
    revokeRecordingConsent,
    confirmRecordingSummary,
    discardRecordingSummary,
    attachRecordingSummary,
  };
}
