import { getRegisteredEnvBool } from '../foundation/env.js';
import { createLogger, formatDiagnostic } from '../logger.js';
import {
  missionBlueprintHasErrors,
  validateMissionBlueprint,
  type MissionValidationMessage,
} from './mission-blueprint-validation.js';
import { WorkCoordinationError } from '../workforce/work-coordination-error.js';

const logger = createLogger('mission-blueprint-preflight');

/**
 * W6: blocking blueprint preflight, opt-in via
 * `KYBERION_MISSION_BLUEPRINT_ENFORCE=1`.
 *
 * The journal boundary (`writeProvisionedJsonFrom` →
 * `reportNextTasksBlueprint`) validates but never blocks: kickoff and
 * rebuilds legitimately write NEXT_TASKS.json in staged/partial form, so an
 * error there is advisory. This module exists for the honest *commit* seam —
 * the one place a fully-formed planner board is handed over for persistence
 * (`persistPlanningPacket`). Armed there, a blueprint carrying errors
 * (missing/duplicate task ids, dangling depends_on, dependency cycles)
 * refuses the commit with a stable-coded `WorkCoordinationError`; warnings
 * (missing deliverable/acceptance phrasing) remain non-blocking and are
 * logged at debug, matching journal policy.
 */
export function missionBlueprintPreflightEnforced(): boolean {
  return getRegisteredEnvBool('KYBERION_MISSION_BLUEPRINT_ENFORCE') === true;
}

function formatBlueprintFinding(missionId: string, msg: MissionValidationMessage): string {
  return formatDiagnostic({
    component: 'mission-blueprint-preflight',
    what: `[${msg.code}] ${msg.message}`,
    why: `planner commit for mission ${missionId} hands over a board that fails blueprint validation`,
    next: 'fix the planner blueprint and retry the commit — or unset KYBERION_MISSION_BLUEPRINT_ENFORCE to restore advisory-only validation',
    evidence: msg.subject_id ? `task: ${msg.subject_id}` : 'NEXT_TASKS planner packet',
  });
}

/**
 * Validate the planner's `next_tasks` blueprint before it commits.
 *
 * - Flag unset → pure no-op (today's behavior everywhere).
 * - Flag set + warnings only → logs them at debug, lets the commit proceed.
 * - Flag set + any error → throws `WorkCoordinationError` (code
 *   'validation_error') whose message carries every finding with the
 *   original stable blueprint codes (e.g. `MISSION_DEPENDENCY_CYCLE`), and
 *   `details.findings` for structured consumers. Nothing has been written
 *   yet at the call sites this is wired to.
 */
export function assertMissionBlueprintPreflight(
  missionId: string,
  rawTasks: unknown
): MissionValidationMessage[] {
  if (!missionBlueprintPreflightEnforced()) return [];
  const findings = validateMissionBlueprint(rawTasks);
  const errors = findings.filter((f) => f.severity === 'error');
  for (const f of findings) {
    const line = formatBlueprintFinding(missionId, f);
    if (f.severity === 'error') logger.warn(line);
    else logger.debug(line);
  }
  if (!missionBlueprintHasErrors(findings)) return findings;
  throw new WorkCoordinationError(
    'validation_error',
    `mission ${missionId} blueprint refused at planner commit [MISSION_BLUEPRINT_INVALID]: ` +
      errors.map((e) => `[${e.code}] ${e.message}`).join('; '),
    { mission_id: missionId, findings }
  );
}
