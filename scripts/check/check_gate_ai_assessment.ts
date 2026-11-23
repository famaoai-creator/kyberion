import { createStandardYargs } from '@agent/core/cli-utils';
import {
  checkGateAiAssessmentStage,
  GATE_AI_ASSESSMENT_STAGES,
  resolveGateReviewMission,
  type GateAiAssessmentStage,
} from '../lib/gate-ai-assessment.js';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';

export const runCheckGateAiAssessment = defineScript({
  name: 'gate-ai-assessment',
  flags: ['json', 'quiet', 'dry-run'],
  run(context) {
    const args = createStandardYargs(['node', 'gate-ai-assessment', ...context.argv])
      .exitProcess(false)
      .strict()
      .option('mission', {
        type: 'string',
        demandOption: true,
        describe: 'Mission ID (e.g. MSN-GATE-<slug>)',
      })
      .option('stage', {
        type: 'string',
        choices: GATE_AI_ASSESSMENT_STAGES,
        default: 'assessment' as const,
        describe:
          'assessment = convening policy (PACKET_READY); decision = human record bound to the assessment digest (GATE_DECISION)',
      })
      .option('assessment', {
        type: 'string',
        describe:
          'Assessment JSON path, mission-relative or evidence/-relative (default evidence/gate-ai-assessment.json)',
      })
      .option('decision', {
        type: 'string',
        describe:
          'Decision record path, mission-relative or evidence/-relative (default evidence/gate-decision-record.json)',
      })
      .option('min-confidence', {
        type: 'number',
        describe: 'Minimum assessor confidence required to convene (0..1, default 0.5)',
      })
      .option('max-unmet', {
        type: 'number',
        describe: 'Maximum criteria allowed in unmet/unknown state (default 0)',
      })
      .option('allow-missing-required', {
        type: 'boolean',
        default: false,
        describe: 'Do not block on missing/insufficient required artifacts (advisory runs)',
      })
      .option('allow-stale', {
        type: 'boolean',
        default: false,
        describe: 'Skip evaluated-evidence freshness verification (advisory runs)',
      })
      .option('json', { type: 'boolean' })
      .option('quiet', { type: 'boolean' })
      .parseSync();
    if (args['min-confidence'] !== undefined) {
      const value = args['min-confidence'];
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new ScriptExitError(1, '--min-confidence must be a number between 0 and 1.');
      }
    }
    const mission = resolveGateReviewMission(args.mission);
    const result = checkGateAiAssessmentStage(mission, args.stage as GateAiAssessmentStage, {
      ...(args.assessment ? { assessmentPath: args.assessment } : {}),
      ...(args.decision ? { decisionPath: args.decision } : {}),
      ...(args['min-confidence'] !== undefined ? { minConfidence: args['min-confidence'] } : {}),
      ...(args['max-unmet'] !== undefined ? { maxUnmet: args['max-unmet'] } : {}),
      allowMissingRequired: args['allow-missing-required'],
      allowStale: args['allow-stale'],
    });
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_gate_ai_assessment.ts') ||
  isDirectScript(import.meta.url, 'check_gate_ai_assessment.js')
) {
  void runCheckGateAiAssessment();
}
