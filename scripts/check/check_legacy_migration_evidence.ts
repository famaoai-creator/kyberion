import { createStandardYargs } from '@agent/core/cli-utils';
import {
  assertLegacyMigrationEvidence,
  LEGACY_MIGRATION_EVIDENCE_STAGES,
  type LegacyMigrationEvidenceStage,
} from '@agent/core/mission';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export const runCheckLegacyMigrationEvidence = defineScript({
  name: 'legacy-migration-evidence',
  flags: ['json', 'quiet', 'dry-run'],
  run(context) {
    const args = createStandardYargs(['node', 'legacy-migration-evidence', ...context.argv])
      .exitProcess(false)
      .strict()
      .option('mission', { type: 'string', demandOption: true })
      .option('stage', {
        type: 'string',
        choices: [...LEGACY_MIGRATION_EVIDENCE_STAGES],
        demandOption: true,
      })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    try {
      const result = assertLegacyMigrationEvidence(
        args.mission,
        args.stage as LegacyMigrationEvidenceStage
      );
      context.print(result);
      return result;
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'check_legacy_migration_evidence.ts') ||
  isDirectScript(import.meta.url, 'check_legacy_migration_evidence.js')
) {
  void runCheckLegacyMigrationEvidence();
}
