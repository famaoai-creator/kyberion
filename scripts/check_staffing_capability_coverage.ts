import {
  buildStaffingCoverageReport,
  buildTemplateReachabilityReport,
  formatStaffingCoverageReport,
  formatTemplateReachabilityReport,
} from '@agent/core/staffing-coverage';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * TC-11: fail when the agent pool cannot actually supply what the roster
 * asks for.
 *
 * Team roles declare `required_capabilities` and agent profiles declare
 * `capabilities`; nothing compared the two, and selection scores a shortfall
 * rather than rejecting it, so an uncoverable role was still filled by the
 * least-bad candidate without a word. This gate closes that silence for the
 * roles the system actually demands — one an obligation can require, or one a
 * mission-team template declares required — and prints the full coverage
 * table either way so the remaining thin roles stay visible.
 */
export const runCheckStaffingCapabilityCoverage = defineScript({
  name: 'check:staffing-capability-coverage',
  flags: [],
  run(context) {
    const report = buildStaffingCoverageReport();
    context.print(formatStaffingCoverageReport(report));

    // TC-14: an unknown template resolves to the default team instead of
    // failing, so a typo'd route would silently field the wrong line-up.
    const reachability = buildTemplateReachabilityReport();
    context.print(formatTemplateReachabilityReport(reachability));

    const failures = [
      ...report.violations.map(
        (violation) => `[${violation.kind}] ${violation.team_role}: ${violation.detail}`
      ),
      ...reachability.dangling_references.map(
        (entry) =>
          `[dangling_template_reference] ${entry.template_id}: referenced by ${entry.referenced_by.join(', ')} but not defined in mission-team-templates.`
      ),
    ];
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    context.print('[check:staffing-capability-coverage] OK');
    return { report, reachability };
  },
});

if (
  isDirectScript(import.meta.url, 'check_staffing_capability_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_staffing_capability_coverage.js')
)
  void runCheckStaffingCapabilityCoverage();
