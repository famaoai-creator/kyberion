import {
  buildTeamDecisionSupportReport,
  formatTeamDecisionSupportReport,
} from '@agent/core/team-decision-support-metrics';
import { defineScript, isDirectScript } from './lib/harness.js';

/**
 * TC-19: report how the roster proposer and the advisory panel are actually
 * doing, across missions, from recorded outcomes only.
 *
 * Read-only by design. Both features are opt-in additions to a path that
 * worked without them, so the decision to keep them on belongs to whoever
 * reads these numbers — particularly `follow_up_restaff_rate`, which is the
 * one a flattering proposer cannot hide behind.
 */
export const runReportTeamDecisionSupport = defineScript({
  name: 'report:team-decision-support',
  flags: [],
  run(context) {
    const json = context.argv.includes('--json');
    const report = buildTeamDecisionSupportReport();
    context.print(json ? JSON.stringify(report, null, 2) : formatTeamDecisionSupportReport(report));
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'report_team_decision_support.ts') ||
  isDirectScript(import.meta.url, 'report_team_decision_support.js')
)
  void runReportTeamDecisionSupport();
