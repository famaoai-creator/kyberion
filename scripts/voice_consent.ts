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

import {
  grantVoiceConsent as grantVoiceConsentRecord,
  logger,
  readVoiceConsent,
  revokeVoiceConsent as revokeVoiceConsentRecord,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { isDirectScript } from './lib/harness.js';

function grant(
  missionId: string,
  operator: string,
  scope?: string,
  note?: string,
  force?: boolean,
  expiresAt?: string
): void {
  grantVoiceConsentRecord({
    missionId,
    operator,
    scope,
    note,
    force,
    expiresAt,
  });
  logger.info(`✅ voice consent granted for mission ${missionId} (operator=${operator})`);
}

function revoke(missionId: string, note?: string): void {
  const existing = readVoiceConsent(missionId);
  if (!existing || existing.consent === 'revoked') {
    logger.info(`ℹ️ voice consent already revoked / never granted for mission ${missionId}`);
    return;
  }
  const record = revokeVoiceConsentRecord(missionId, note);
  if (!record) return;
  logger.info(`🔒 voice consent revoked for mission ${missionId}`);
}

function status(missionId: string): void {
  const existing = readVoiceConsent(missionId);
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
        argv.expiresAt ? String(argv.expiresAt) : undefined
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

if (
  isDirectScript(import.meta.url, 'voice_consent.ts') ||
  isDirectScript(import.meta.url, 'voice_consent.js')
) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exitCode = 1;
  });
}

export { grant as grantVoiceConsent, revoke as revokeVoiceConsent, status as voiceConsentStatus };
