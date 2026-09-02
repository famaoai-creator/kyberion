import { MissionEvidenceDoc } from './mission-evidence-doc.js';
import { resolveIdentityContext } from './authority.js';
import { nowIso } from './foundation/time.js';

export interface VoiceConsentRecord {
  consent: 'granted' | 'revoked';
  mission_id: string;
  operator_handle: string;
  scope?: string;
  note?: string;
  tenant_slug?: string;
  granted_at?: string;
  revoked_at?: string;
  expires_at?: string;
  audit_event_id?: string;
}

export interface VoiceConsentValidationOptions {
  missionId: string;
  tenantSlug?: string;
  nowMs?: number;
}

export interface VoiceConsentValidationResult {
  allowed: boolean;
  reason?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Validate the mission-scoped consent record without reading or writing files. */
export function validateVoiceConsentRecord(
  value: unknown,
  options: VoiceConsentValidationOptions
): VoiceConsentValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { allowed: false, reason: 'voice-consent.json is malformed: expected an object' };
  }

  const record = value as Record<string, unknown>;
  if (record.consent !== 'granted') {
    return {
      allowed: false,
      reason: `voice-consent.json present but consent != 'granted' (got '${String(record.consent)}')`,
    };
  }

  const consentMissionId = normalizeOptionalString(record.mission_id);
  const operatorHandle = normalizeOptionalString(record.operator_handle);
  if (!consentMissionId || !operatorHandle) {
    return {
      allowed: false,
      reason: 'voice-consent.json is malformed: mission_id and operator_handle are required',
    };
  }
  if (consentMissionId !== options.missionId) {
    return {
      allowed: false,
      reason: `voice-consent.json mission_id '${consentMissionId}' does not match active mission '${options.missionId}'`,
    };
  }

  const expiresAt = normalizeOptionalString(record.expires_at);
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) {
      return { allowed: false, reason: `voice-consent.json expires_at is invalid: ${expiresAt}` };
    }
    if (expiresMs <= (options.nowMs ?? Date.now())) {
      return { allowed: false, reason: `voice-consent.json expired at ${expiresAt}` };
    }
  }

  const activeTenant = normalizeOptionalString(options.tenantSlug);
  if (activeTenant) {
    const consentTenant = normalizeOptionalString(record.tenant_slug);
    if (consentTenant !== activeTenant) {
      return {
        allowed: false,
        reason: `voice-consent.json tenant_slug '${consentTenant ?? 'missing'}' does not match active tenant '${activeTenant}'`,
      };
    }
  }

  return { allowed: true };
}

export function isVoiceConsentRecord(doc: unknown): doc is VoiceConsentRecord {
  if (!doc || typeof doc !== 'object') return false;
  const record = doc as Partial<VoiceConsentRecord>;
  return (
    (record.consent === 'granted' || record.consent === 'revoked') &&
    typeof record.mission_id === 'string' &&
    typeof record.operator_handle === 'string' &&
    (record.tenant_slug === undefined || typeof record.tenant_slug === 'string') &&
    (record.expires_at === undefined || typeof record.expires_at === 'string')
  );
}

function consentDoc(missionId: string): MissionEvidenceDoc<VoiceConsentRecord> {
  return new MissionEvidenceDoc<VoiceConsentRecord>({
    mission_id: missionId,
    filename: 'voice-consent.json',
    agent_id: 'voice-consent',
    validate: isVoiceConsentRecord,
  });
}

export function grantVoiceConsent(options: {
  missionId: string;
  operator: string;
  scope?: string;
  note?: string;
  force?: boolean;
  expiresAt?: string;
}): VoiceConsentRecord {
  const doc = consentDoc(options.missionId);
  const existing = doc.read();
  if (existing?.consent === 'granted' && !options.force) {
    throw new Error(
      `voice-consent.json already declares consent=granted for mission ${options.missionId}. Use --force to overwrite.`
    );
  }
  if (options.expiresAt && !Number.isFinite(Date.parse(options.expiresAt))) {
    throw new Error(`expires_at must be an ISO-compatible datetime (got '${options.expiresAt}')`);
  }
  const tenantSlug = resolveIdentityContext().tenantSlug;
  const record: VoiceConsentRecord = {
    consent: 'granted',
    mission_id: options.missionId,
    operator_handle: options.operator,
    granted_at: nowIso(),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
  const { audit_event_id } = doc.write(record, {
    action: 'voice_consent.grant',
    reason: `operator=${options.operator}${options.scope ? ` scope="${options.scope}"` : ''}`,
    metadata: options.scope ? { scope: options.scope } : undefined,
  });
  if (audit_event_id) {
    record.audit_event_id = audit_event_id;
    doc.write(record);
  }
  return record;
}

export function revokeVoiceConsent(missionId: string, note?: string): VoiceConsentRecord | null {
  const doc = consentDoc(missionId);
  const existing = doc.read();
  if (!existing || existing.consent === 'revoked') return existing;
  const record: VoiceConsentRecord = {
    ...existing,
    consent: 'revoked',
    revoked_at: nowIso(),
    ...(note ? { note } : {}),
  };
  const { audit_event_id } = doc.write(record, {
    action: 'voice_consent.revoke',
    reason: note,
  });
  if (audit_event_id) {
    record.audit_event_id = audit_event_id;
    doc.write(record);
  }
  return record;
}

export function readVoiceConsent(missionId: string): VoiceConsentRecord | null {
  return consentDoc(missionId).read();
}
