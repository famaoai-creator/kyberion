import { MissionEvidenceDoc } from './mission-evidence-doc.js';
import { resolveIdentityContext } from './authority.js';

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
    granted_at: new Date().toISOString(),
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
    revoked_at: new Date().toISOString(),
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
