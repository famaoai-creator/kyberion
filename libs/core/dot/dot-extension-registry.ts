/**
 * Dot extension registry — plain ordered arrays, one per seam in
 * `dot-extensions.ts`. A capability registers by appending ONE line to the
 * matching array; the cores iterate them in array order (prompt sections sort
 * by their own `order`). Kept as data, not a mutable registry API, so the
 * active set is reviewable in one file.
 */

import type {
  DotDecisionRelaxer,
  DotDigestSection,
  DotDispositionOverride,
  DotFloorContributor,
  DotPreGateCheck,
  DotPromptSection,
  DotStatusSection,
  DotWakeTool,
} from './dot-extensions.js';
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

export const DOT_PROMPT_SECTIONS: DotPromptSection[] = [];
export const DOT_FLOOR_CONTRIBUTORS: DotFloorContributor[] = [];
export const DOT_PRE_GATE_CHECKS: DotPreGateCheck[] = [];
export const DOT_DECISION_RELAXERS: DotDecisionRelaxer[] = [];
export const DOT_DISPOSITION_OVERRIDES: DotDispositionOverride[] = [];
export const DOT_WAKE_TOOLS: DotWakeTool[] = [];
export const DOT_STATUS_SECTIONS: DotStatusSection[] = [];
export const DOT_DIGEST_SECTIONS: DotDigestSection[] = [];

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
