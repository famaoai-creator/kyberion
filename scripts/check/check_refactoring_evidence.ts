import { createStandardYargs } from '@agent/core/cli-utils';
import {
  assertRefactoringEvidence,
  REFACTORING_EVIDENCE_STAGES,
  type RefactoringEvidenceStage,
} from '@agent/core/mission/refactoring-evidence';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export const runCheckRefactoringEvidence = defineScript({
  name: 'refactoring-evidence',
  flags: ['json', 'quiet', 'dry-run'],
  run(context) {
    const args = createStandardYargs(['node', 'refactoring-evidence', ...context.argv])
      .exitProcess(false)
      .strict()
      .option('mission', { type: 'string', demandOption: true })
      .option('stage', {
        type: 'string',
        choices: [...REFACTORING_EVIDENCE_STAGES],
        demandOption: true,
      })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    try {
      const result = assertRefactoringEvidence(
        args.mission,
        args.stage as RefactoringEvidenceStage
      );
      context.print(result);
      return result;
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'check_refactoring_evidence.ts') ||
  isDirectScript(import.meta.url, 'check_refactoring_evidence.js')
) {
  void runCheckRefactoringEvidence();
}
