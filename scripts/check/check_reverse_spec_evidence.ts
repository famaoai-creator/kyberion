import { createStandardYargs } from '@agent/core/cli-utils';
import {
  assertReverseSpecEvidence,
  REVERSE_SPEC_EVIDENCE_STAGES,
  type ReverseSpecEvidenceStage,
} from '@agent/core/mission';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export const runCheckReverseSpecEvidence = defineScript({
  name: 'reverse-spec-evidence',
  flags: ['json', 'quiet', 'dry-run'],
  run(context) {
    const args = createStandardYargs(['node', 'reverse-spec-evidence', ...context.argv])
      .exitProcess(false)
      .strict()
      .option('mission', { type: 'string', demandOption: true })
      .option('stage', {
        type: 'string',
        choices: [...REVERSE_SPEC_EVIDENCE_STAGES],
        demandOption: true,
      })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    try {
      const result = assertReverseSpecEvidence(
        args.mission,
        args.stage as ReverseSpecEvidenceStage
      );
      context.print(result);
      return result;
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
  },
});

if (
  isDirectScript(import.meta.url, 'check_reverse_spec_evidence.ts') ||
  isDirectScript(import.meta.url, 'check_reverse_spec_evidence.js')
) {
  void runCheckReverseSpecEvidence();
}
