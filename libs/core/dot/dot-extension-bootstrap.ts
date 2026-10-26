/**
 * Dot extension bootstrap — registers every dot capability into the leaf
 * arrays of `dot-extension-registry.ts` through its typed registration API.
 * New capabilities register their own bundle at a composition boundary;
 * order is explicit and duplicate hook identities are rejected atomically.
 *
 * Kept out of the registry so the cores never import the extensions
 * (extensions import the cores — the other direction would be a runtime
 * import cycle). Entry points that run wakes / dispatch import this module
 * (`dot-wake-orchestration`, the `@agent/core` barrel, the dot scripts);
 * importing it registers once, and `ensureDotExtensionsRegistered()` is the
 * explicit idempotent form for callers and tests.
 */

import { registerDotExtension } from './dot-extension-registry.js';
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
import { dotEventIntakeStatusSection } from './dot-event-intake-diagnostics.js';
import { dotArbitrationPreGateCheck } from './dot-arbitration.js';
import { dotProgressPromptSection, dotProgressStatusSection } from './dot-progress.js';

let registered = false;

/** Populate the dot extension registry once (idempotent). */
export function ensureDotExtensionsRegistered(): void {
  if (registered) return;
  registerDotExtension({
    id: 'dot-builtin-capabilities',
    order: 0,
    metadata: { provenance: 'builtin', source: 'libs/core/dot/dot-extension-bootstrap.ts' },
    hooks: {
      promptSections: [
        DOT_GOAL_GAP_PROMPT_SECTION,
        dotMemoryPromptSection,
        dotFollowupsPromptSection,
        dotWorkResultsPromptSection(),
        dotOutcomesPromptSection(),
        dotProgressPromptSection(),
      ],
      wakeTools: [dotUpdateMemoryTool, dotScheduleFollowupTool],
      floorContributors: [DOT_BUDGET_FLOOR_CONTRIBUTOR, dotAutonomyFloorContributor()],
      preGateChecks: [dotArbitrationPreGateCheck()],
      decisionRelaxers: [dotAutonomyDecisionRelaxer()],
      dispositionOverrides: [dotAutonomyDispositionOverride()],
      statusSections: [
        DOT_KEY_RESULTS_STATUS_SECTION,
        DOT_BUDGET_STATUS_SECTION,
        dotOutcomesStatusSection(),
        dotProgressStatusSection(),
        dotAutonomyStatusSection(),
        dotExecutorStatusSection(),
        dotEventIntakeStatusSection(),
      ],
      digestSections: [
        DOT_KEY_RESULTS_DIGEST_SECTION,
        DOT_BUDGET_DIGEST_SECTION,
        dotOutcomesDigestSection(),
        dotAutonomyDigestSection(),
      ],
    },
  });
  // A construction or registration failure leaves initialization retryable.
  registered = true;
}

ensureDotExtensionsRegistered();
