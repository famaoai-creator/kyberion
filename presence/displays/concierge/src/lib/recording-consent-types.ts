/**
 * WI-15 (docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md §9):
 * shared types and pure response parsers behind the settings 「PC 操作の記録」
 * pane. Split out the same way `settings-types.ts` is — no I/O, no `t()` —
 * so `use-recording-consent.ts` and `RecordingConsentSection.tsx` can both
 * import it without a page-module dependency.
 */

export type RecordingConsentSource = 'desktop_recording' | 'browser_recording';
export type RecordingObservationKind = 'active_window' | 'browser_tabs' | 'focused_input';

export type RecordingConsent = {
  consent_id: string;
  sources: RecordingConsentSource[];
  observation_kinds: RecordingObservationKind[];
  purpose: string;
  granted_at: string;
  expires_at: string;
  revoked_at?: string;
};

export type RecordingConsentStanding = {
  consents: RecordingConsent[];
  sources: RecordingConsentSource[];
  observation_kinds: RecordingObservationKind[];
  max_days: number;
};

export type RecordingObservationStatus = 'pending_review' | 'confirmed' | 'discarded';

export type RecordingObservationSummary = {
  summary_id: string;
  status: RecordingObservationStatus;
  source: RecordingConsentSource;
  digest: string;
  apps: string[];
  hosts: string[];
  step_count: number;
};

export type RecordingCandidateEntry = { entry_id: string; title: string };

export type RecordingObservationsView = {
  summaries: RecordingObservationSummary[];
  candidateEntries: RecordingCandidateEntry[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecordingConsentSourceArray(value: unknown): value is RecordingConsentSource[] {
  return (
    isStringArray(value) &&
    value.every((entry) => entry === 'desktop_recording' || entry === 'browser_recording')
  );
}

function isRecordingObservationKindArray(value: unknown): value is RecordingObservationKind[] {
  return (
    isStringArray(value) &&
    value.every(
      (entry) => entry === 'active_window' || entry === 'browser_tabs' || entry === 'focused_input'
    )
  );
}

function isRecordingConsent(value: unknown): value is RecordingConsent {
  if (!isRecord(value)) return false;
  if (
    typeof value.consent_id !== 'string' ||
    !isRecordingConsentSourceArray(value.sources) ||
    !isRecordingObservationKindArray(value.observation_kinds) ||
    typeof value.purpose !== 'string' ||
    typeof value.granted_at !== 'string' ||
    typeof value.expires_at !== 'string'
  ) {
    return false;
  }
  return value.revoked_at === undefined || typeof value.revoked_at === 'string';
}

export function parseRecordingConsentStandingResponse(
  value: unknown
): RecordingConsentStanding | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  if (
    !Array.isArray(value.consents) ||
    !value.consents.every(isRecordingConsent) ||
    !isRecordingConsentSourceArray(value.sources) ||
    !isRecordingObservationKindArray(value.observation_kinds) ||
    typeof value.max_days !== 'number'
  ) {
    return undefined;
  }
  return {
    consents: value.consents,
    sources: value.sources,
    observation_kinds: value.observation_kinds,
    max_days: value.max_days,
  };
}

function isRecordingObservationStatus(value: unknown): value is RecordingObservationStatus {
  return value === 'pending_review' || value === 'confirmed' || value === 'discarded';
}

function isRecordingObservationSummary(value: unknown): value is RecordingObservationSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.summary_id === 'string' &&
    isRecordingObservationStatus(value.status) &&
    (value.source === 'desktop_recording' || value.source === 'browser_recording') &&
    typeof value.digest === 'string' &&
    isStringArray(value.apps) &&
    isStringArray(value.hosts) &&
    typeof value.step_count === 'number'
  );
}

function isRecordingCandidateEntry(value: unknown): value is RecordingCandidateEntry {
  if (!isRecord(value)) return false;
  return typeof value.entry_id === 'string' && typeof value.title === 'string';
}

export function parseRecordingObservationsResponse(
  value: unknown
): RecordingObservationsView | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  if (
    !Array.isArray(value.summaries) ||
    !value.summaries.every(isRecordingObservationSummary) ||
    !Array.isArray(value.candidate_entries) ||
    !value.candidate_entries.every(isRecordingCandidateEntry)
  ) {
    return undefined;
  }
  return { summaries: value.summaries, candidateEntries: value.candidate_entries };
}
