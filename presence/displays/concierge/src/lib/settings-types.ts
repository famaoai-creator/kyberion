import type { Setup as SetupPayload } from './setup-response';

/**
 * FD-06/FD-07 (設定): shared types and pure response parsers behind
 * `/settings`. Split out of `settings/page.tsx` (KP gate: max-file-lines) so
 * the section components under `settings/sections/` can import them without
 * depending on the page module. No I/O, no `t()`/`frontDeskText()` — same
 * posture as `settings-view.ts`.
 */

export type NotificationChannelOption = { surface: string; display_name: string; status: string };
export type NotificationTarget = { surface: string; target: string };
export type PluginEntry = {
  id: string;
  trust: string;
  status: string;
  source: string;
  requested_by?: string;
  approval_status?: string;
};
export type ConfigPresetInput = {
  key: string;
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required: boolean;
  values?: string[];
  default?: string;
};
export type ConfigPreset = {
  id: string;
  category: string;
  description: string;
  inputs: ConfigPresetInput[];
  write_target_count: number;
};
export type ConfigMissionItem = {
  id: string;
  preset: string;
  tenant: string;
  status: string;
  created_at: string;
};
export type Setup = SetupPayload;

export type Notice = { text: string; error?: boolean } | null;

export type SettingsRole = 'owner' | 'approver' | 'viewer';
export type SettingsTenantView = {
  tenant_slug: string;
  display_name: string;
  role: SettingsRole;
  status: 'active' | 'suspended' | 'archived';
};

// FD-07: 組織とメンバー member list + add form.
export type SettingsMember = {
  member_id: string;
  display_name: string;
  status: 'active' | 'suspended';
  sign_in: 'local' | 'token';
  memberships: Array<{ tenant_slug: string; role: SettingsRole }>;
};

export function isSettingsRole(value: unknown): value is SettingsRole {
  return value === 'owner' || value === 'approver' || value === 'viewer';
}

export function isSettingsTenantView(value: unknown): value is SettingsTenantView {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tenant_slug === 'string' &&
    typeof record.display_name === 'string' &&
    isSettingsRole(record.role) &&
    (record.status === 'active' || record.status === 'suspended' || record.status === 'archived')
  );
}

export function parseSettingsMe(
  value: unknown
): { viewing: SettingsTenantView | null; tenants: SettingsTenantView[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.tenants)) return undefined;
  if (!record.tenants.every(isSettingsTenantView)) return undefined;
  if (record.viewing !== null && !isSettingsTenantView(record.viewing)) return undefined;
  return {
    viewing: (record.viewing as SettingsTenantView | null) ?? null,
    tenants: record.tenants,
  };
}

export function isSettingsMember(value: unknown): value is SettingsMember {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.member_id === 'string' &&
    typeof record.display_name === 'string' &&
    (record.status === 'active' || record.status === 'suspended') &&
    (record.sign_in === 'local' || record.sign_in === 'token') &&
    Array.isArray(record.memberships) &&
    record.memberships.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        typeof (m as Record<string, unknown>).tenant_slug === 'string' &&
        isSettingsRole((m as Record<string, unknown>).role)
    )
  );
}

export function parseMembersResponse(value: unknown): SettingsMember[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.members)) return undefined;
  if (!record.members.every(isSettingsMember)) return undefined;
  return record.members;
}

export function parseAddMemberResponse(
  value: unknown
): { member: SettingsMember; token: string | null } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !isSettingsMember(record.member)) return undefined;
  return { member: record.member, token: typeof record.token === 'string' ? record.token : null };
}

export function parseChronosLink(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.chronos_url !== 'string') return undefined;
  return record.chronos_url;
}

// 声と話し方: TTS engine / STT backend / input device selection, proxied
// through /api/voice/selection (GET reads the current preferences + every
// selectable candidate; POST saves one field and returns the new snapshot).
export type VoiceSelectionTtsCandidate = {
  engine_id: string;
  display_name: string;
  selectable: boolean;
};
export type VoiceSelectionSttCandidate = {
  backend: string;
  display_name: string;
  selectable: boolean;
};
export type VoiceSelection = {
  preferences: { tts_engine_id: string; stt_backend: string };
  tts: { candidates: VoiceSelectionTtsCandidate[] };
  stt: { candidates: VoiceSelectionSttCandidate[] };
};

function isVoiceSelectionTtsCandidate(value: unknown): value is VoiceSelectionTtsCandidate {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.engine_id === 'string' &&
    typeof record.display_name === 'string' &&
    typeof record.selectable === 'boolean'
  );
}

function isVoiceSelectionSttCandidate(value: unknown): value is VoiceSelectionSttCandidate {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.backend === 'string' &&
    typeof record.display_name === 'string' &&
    typeof record.selectable === 'boolean'
  );
}

export function parseVoiceSelectionResponse(value: unknown): VoiceSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true) return undefined;
  const preferences = record.preferences;
  if (
    !preferences ||
    typeof preferences !== 'object' ||
    typeof (preferences as Record<string, unknown>).tts_engine_id !== 'string' ||
    typeof (preferences as Record<string, unknown>).stt_backend !== 'string'
  ) {
    return undefined;
  }
  const tts = record.tts;
  const stt = record.stt;
  if (
    !tts ||
    typeof tts !== 'object' ||
    !Array.isArray((tts as Record<string, unknown>).candidates) ||
    !(tts as Record<string, unknown>).candidates ||
    !(tts as { candidates: unknown[] }).candidates.every(isVoiceSelectionTtsCandidate)
  ) {
    return undefined;
  }
  if (
    !stt ||
    typeof stt !== 'object' ||
    !Array.isArray((stt as Record<string, unknown>).candidates) ||
    !(stt as { candidates: unknown[] }).candidates.every(isVoiceSelectionSttCandidate)
  ) {
    return undefined;
  }
  return {
    preferences: preferences as VoiceSelection['preferences'],
    tts: tts as VoiceSelection['tts'],
    stt: stt as VoiceSelection['stt'],
  };
}

// 組織とメンバー 研修: read-only catalog (proxied via /api/training/catalog)
// plus per-tenant assignments (/api/training/assignments) — same shape as
// libs/core/training-catalog.ts, duplicated here because the client never
// imports @agent/core/secure-io-backed modules directly.
export type TrainingTrack = { id: string; title: string };
export type TrainingAssignmentStatus = 'not_started' | 'in_progress' | 'complete';
export type TrainingAssignmentEntry = {
  member_id: string;
  track_id: string;
  status: TrainingAssignmentStatus;
};
export type TrainingAssignments = {
  tenant_slug: string;
  assignments: TrainingAssignmentEntry[];
};

function isTrainingTrack(value: unknown): value is TrainingTrack {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.title === 'string';
}

export function parseTrainingCatalogResponse(value: unknown): TrainingTrack[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const catalog = record.catalog;
  if (record.ok !== true || !catalog || typeof catalog !== 'object') return undefined;
  const tracks = (catalog as Record<string, unknown>).tracks;
  if (!Array.isArray(tracks) || !tracks.every(isTrainingTrack)) return undefined;
  return tracks;
}

function isTrainingAssignmentStatus(value: unknown): value is TrainingAssignmentStatus {
  return value === 'not_started' || value === 'in_progress' || value === 'complete';
}

function isTrainingAssignmentEntry(value: unknown): value is TrainingAssignmentEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.member_id === 'string' &&
    typeof record.track_id === 'string' &&
    isTrainingAssignmentStatus(record.status)
  );
}

function isTrainingAssignments(value: unknown): value is TrainingAssignments {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tenant_slug === 'string' &&
    Array.isArray(record.assignments) &&
    record.assignments.every(isTrainingAssignmentEntry)
  );
}

export function parseTrainingAssignmentsResponse(
  value: unknown
): TrainingAssignments[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.assignments)) return undefined;
  if (!record.assignments.every(isTrainingAssignments)) return undefined;
  return record.assignments;
}
