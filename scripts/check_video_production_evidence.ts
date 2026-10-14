import { createStandardYargs } from '@agent/core/cli-utils';
import {
  checkVideoProductionEvidence,
  requestVideoProductionApproval,
  resolveVideoMission,
  VIDEO_PRODUCTION_STAGES,
  type VideoProductionStage,
} from './lib/video-production-evidence.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const runCheckVideoProductionEvidence = defineScript({
  name: 'video-production-evidence',
  flags: ['json', 'quiet', 'dry-run'],
  run(context) {
    const args = createStandardYargs(['node', 'video-production-evidence', ...context.argv])
      .exitProcess(false)
      .strict()
      .option('mission', { type: 'string', demandOption: true })
      .option('stage', { type: 'string', choices: VIDEO_PRODUCTION_STAGES })
      .option('request-approval', { type: 'string', choices: ['prototypes', 'playback'] as const })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    if (!!args.stage === !!args['request-approval']) {
      throw new ScriptExitError(
        1,
        'Use --mission <ID> with --stage <stage> or --request-approval prototypes|playback.'
      );
    }
    if (args['request-approval'] && args['dry-run']) {
      throw new ScriptExitError(
        1,
        'Approval request creation is not supported in dry-run; use --stage prototypes or render for read-only validation.'
      );
    }
    const mission = resolveVideoMission(args.mission);
    const result = args['request-approval']
      ? requestVideoProductionApproval(
          mission,
          args['request-approval'] as 'prototypes' | 'playback'
        )
      : checkVideoProductionEvidence(mission, args.stage as VideoProductionStage);
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_video_production_evidence.ts') ||
  isDirectScript(import.meta.url, 'check_video_production_evidence.js')
) {
  void runCheckVideoProductionEvidence();
}
