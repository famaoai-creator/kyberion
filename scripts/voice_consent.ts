/**
 * Voice consent capture CLI.
 *
 * The meeting-actuator refuses `speak` unless the active mission's
 * evidence directory contains `voice-consent.json` with
 * `consent: 'granted'`. This script writes that document via the
 * shared `MissionEvidenceDoc<T>` abstraction so the read/write/audit
 * plumbing stays in one place.
 *
 * Usage:
 *   pnpm meeting:consent grant   --mission MSN-… --operator famao --scope "..."
 *   pnpm meeting:consent revoke  --mission MSN-… [--note ...]
 *   pnpm meeting:consent status  --mission MSN-…
 *
 * Refusal semantics:
 *   - `grant` will refuse if consent is already granted unless --force.
 *   - `revoke` is idempotent.
 */

import { logger, MissionEvidenceDoc, resolveIdentityContext } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

interface VoiceConsentRecord {
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

function isVoiceConsentRecord(doc: unknown): doc is VoiceConsentRecord {
  if (!doc || typeof doc !== 'object') return false;
  const r = doc as Partial<VoiceConsentRecord>;
  return (
    (r.consent === 'granted' || r.consent === 'revoked') &&
    typeof r.mission_id === 'string' &&
    typeof r.operator_handle === 'string' &&
    (r.tenant_slug === undefined || typeof r.tenant_slug === 'string') &&
    (r.expires_at === undefined || typeof r.expires_at === 'string')
  );
}

function consentDoc(missionId: string): MissionEvidenceDoc<VoiceConsentRecord> {
  return new MissionEvidenceDoc<VoiceConsentRecord>({
    mission_id: missionId,
    filename: 'voice-consent.json',
    agent_id: 'voice-consent-cli',
    validate: isVoiceConsentRecord,
  });
}

function grant(
  missionId: string,
  operator: string,
  scope?: string,
  note?: string,
  force?: boolean,
  expiresAt?: string,
): void {
  const doc = consentDoc(missionId);
  const existing = doc.read();
  if (existing && existing.consent === 'granted' && !force) {
    throw new Error(
      `voice-consent.json already declares consent=granted for mission ${missionId}. Use --force to overwrite.`,
    );
  }
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`expires_at must be an ISO-compatible datetime (got '${expiresAt}')`);
  }
  const tenantSlug = resolveIdentityContext().tenantSlug;
  const record: VoiceConsentRecord = {
    consent: 'granted',
    mission_id: missionId,
    operator_handle: operator,
    granted_at: new Date().toISOString(),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(scope ? { scope } : {}),
    ...(note ? { note } : {}),
  };
  const { audit_event_id } = doc.write(record, {
    action: 'voice_consent.grant',
    reason: `operator=${operator}${scope ? ` scope="${scope}"` : ''}`,
    metadata: scope ? { scope } : undefined,
  });
  if (audit_event_id) {
    record.audit_event_id = audit_event_id;
    doc.write(record);
  }
  logger.info(`✅ voice consent granted for mission ${missionId} (operator=${operator})`);
}

function revoke(missionId: string, note?: string): void {
  const doc = consentDoc(missionId);
  const existing = doc.read();
  if (!existing || existing.consent === 'revoked') {
    logger.info(`ℹ️ voice consent already revoked / never granted for mission ${missionId}`);
    return;
  }
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
  logger.info(`🔒 voice consent revoked for mission ${missionId}`);
}

function status(missionId: string): void {
  const doc = consentDoc(missionId);
  const existing = doc.read();
  if (!existing) {
    logger.info(`(no voice-consent.json yet for mission ${missionId})`);
    return;
  }
  logger.info(JSON.stringify(existing, null, 2));
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .command('grant', 'Grant voice consent for the mission', () => undefined)
    .command('revoke', 'Revoke voice consent for the mission', () => undefined)
    .command('status', 'Print current consent state for the mission', () => undefined)
    .option('mission', { type: 'string', demandOption: true })
    .option('operator', { type: 'string', default: 'operator' })
    .option('scope', { type: 'string' })
    .option('note', { type: 'string' })
    .option('force', { type: 'boolean', default: false })
    .option('expires-at', { type: 'string', describe: 'ISO datetime when the grant expires' })
    .demandCommand(1)
    .parseSync();

  const missionId = String(argv.mission);
  const command = String(argv._[0]);

  switch (command) {
    case 'grant':
      grant(
        missionId,
        String(argv.operator),
        argv.scope ? String(argv.scope) : undefined,
        argv.note ? String(argv.note) : undefined,
        Boolean(argv.force),
        argv.expiresAt ? String(argv.expiresAt) : undefined,
      );
      break;
    case 'revoke':
      revoke(missionId, argv.note ? String(argv.note) : undefined);
      break;
    case 'status':
      status(missionId);
      break;
    default:
      throw new Error(`unknown command '${command}' (expected grant|revoke|status)`);
  }
}

const isDirect = process.argv[1] && /voice_consent\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}

export { grant as grantVoiceConsent, revoke as revokeVoiceConsent, status as voiceConsentStatus };
