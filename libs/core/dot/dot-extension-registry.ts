/**
 * Dot extension registry — plain ordered arrays, one per seam in
 * `dot-extensions.ts`. The cores iterate them in array order (prompt sections
 * sort by their own `order`).
 *
 * This module is a dependency leaf: it imports no extension module, so the
 * cores (`dot-runtime`, `dot-dispatch`) can read the arrays without forming a
 * runtime import cycle with the extensions (which import the cores). The
 * active set is populated — and reviewable in one file — by
 * `dot-extension-bootstrap.ts`, which entry points import.
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

export const DOT_PROMPT_SECTIONS: DotPromptSection[] = [];
export const DOT_FLOOR_CONTRIBUTORS: DotFloorContributor[] = [];
export const DOT_PRE_GATE_CHECKS: DotPreGateCheck[] = [];
export const DOT_DECISION_RELAXERS: DotDecisionRelaxer[] = [];
export const DOT_DISPOSITION_OVERRIDES: DotDispositionOverride[] = [];
export const DOT_WAKE_TOOLS: DotWakeTool[] = [];
export const DOT_STATUS_SECTIONS: DotStatusSection[] = [];
export const DOT_DIGEST_SECTIONS: DotDigestSection[] = [];
