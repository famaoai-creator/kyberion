/**
 * Dot extension bootstrap — registers every dot capability into the leaf
 * arrays of `dot-extension-registry.ts`. A capability registers by appending
 * ONE line here; order is significant (cores iterate in array order).
 *
 * Kept out of the registry so the cores never import the extensions
 * (extensions import the cores — the other direction would be a runtime
 * import cycle). Entry points that run wakes / dispatch import this module
 * (`dot-wake-orchestration`, the `@agent/core` barrel, the dot scripts);
 * importing it registers once, and `ensureDotExtensionsRegistered()` is the
 * explicit idempotent form for callers and tests.
 */

import {
  DOT_DECISION_RELAXERS,
  DOT_DIGEST_SECTIONS,
  DOT_DISPOSITION_OVERRIDES,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_PRE_GATE_CHECKS,
  DOT_PROMPT_SECTIONS,
  DOT_STATUS_SECTIONS,
  DOT_WAKE_TOOLS,
} from './dot-extension-registry.js';
import {
  DOT_GOAL_GAP_PROMPT_SECTION,
  DOT_KEY_RESULTS_DIGEST_SECTION,
  DOT_KEY_RESULTS_STATUS_SECTION,
} from './dot-key-results.js';
import { dotMemoryPromptSection, dotUpdateMemoryTool } from './dot-memory.js';
import { dotFollowupsPromptSection, dotScheduleFollowupTool } from './dot-followups.js';
import {
  DOT_BUDGET_DIGEST_SECTION,
  DOT_BUDGET_FLOOR_CONTRIBUTOR,
  DOT_BUDGET_STATUS_SECTION,
} from './dot-budget.js';
import { dotExecutorStatusSection, dotWorkResultsPromptSection } from './dot-executor.js';
import {
  dotAutonomyDecisionRelaxer,
  dotAutonomyDigestSection,
  dotAutonomyDispositionOverride,
  dotAutonomyFloorContributor,
  dotAutonomyStatusSection,
} from './dot-autonomy.js';
import {
  dotOutcomesDigestSection,
  dotOutcomesPromptSection,
  dotOutcomesStatusSection,
} from './dot-outcomes.js';
import { dotArbitrationPreGateCheck } from './dot-arbitration.js';

let registered = false;

/** Populate the dot extension registry once (idempotent). */
export function ensureDotExtensionsRegistered(): void {
  if (registered) return;
  registered = true;

  // DL-03 key results
  DOT_PROMPT_SECTIONS.push(DOT_GOAL_GAP_PROMPT_SECTION);
  DOT_STATUS_SECTIONS.push(DOT_KEY_RESULTS_STATUS_SECTION);
  DOT_DIGEST_SECTIONS.push(DOT_KEY_RESULTS_DIGEST_SECTION);

  // DL-05 memory + DL-09 follow-ups
  DOT_WAKE_TOOLS.push(dotUpdateMemoryTool, dotScheduleFollowupTool);
  DOT_PROMPT_SECTIONS.push(dotMemoryPromptSection, dotFollowupsPromptSection);

  // DL-01 executor results + DL-07 budget wiring
  DOT_PROMPT_SECTIONS.push(dotWorkResultsPromptSection());
  DOT_FLOOR_CONTRIBUTORS.push(DOT_BUDGET_FLOOR_CONTRIBUTOR);
  DOT_STATUS_SECTIONS.push(DOT_BUDGET_STATUS_SECTION);
  DOT_DIGEST_SECTIONS.push(DOT_BUDGET_DIGEST_SECTION);

  // DL-04 outcome evaluation
  DOT_PROMPT_SECTIONS.push(dotOutcomesPromptSection());
  DOT_STATUS_SECTIONS.push(dotOutcomesStatusSection());
  DOT_DIGEST_SECTIONS.push(dotOutcomesDigestSection());

  // DL-11 cross-dot arbitration
  DOT_PRE_GATE_CHECKS.push(dotArbitrationPreGateCheck());

  // DL-10 graduated autonomy
  DOT_FLOOR_CONTRIBUTORS.push(dotAutonomyFloorContributor());
  DOT_DECISION_RELAXERS.push(dotAutonomyDecisionRelaxer());
  DOT_DISPOSITION_OVERRIDES.push(dotAutonomyDispositionOverride());
  DOT_STATUS_SECTIONS.push(dotAutonomyStatusSection());
  DOT_DIGEST_SECTIONS.push(dotAutonomyDigestSection());

  // DL-01 executor status (results + escalations)
  DOT_STATUS_SECTIONS.push(dotExecutorStatusSection());
}

ensureDotExtensionsRegistered();
