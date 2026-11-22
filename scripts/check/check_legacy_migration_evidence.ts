import { createStandardYargs } from '@agent/core/cli-utils';
import {
  assertLegacyMigrationEvidence,
  LEGACY_MIGRATION_EVIDENCE_STAGES,
  resolveReverseSpecMissionDir,
  writeLegacyMigrationSourceSnapshot,
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
      })
      .option('write-source-snapshot', {
        type: 'boolean',
        describe:
          'Freeze the source reverse_spec ledger into evidence/source-spec-snapshot.json (refuses unless its audit passes)',
      })
      .check((parsed) => {
        if (!parsed.stage && !parsed['write-source-snapshot'])
          throw new Error('pass --stage <stage> or --write-source-snapshot');
        return true;
      })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    try {
      if (args['write-source-snapshot']) {
        const written = writeLegacyMigrationSourceSnapshot(
          resolveReverseSpecMissionDir(args.mission)
        );
        context.print(written);
        return written;
      }
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
