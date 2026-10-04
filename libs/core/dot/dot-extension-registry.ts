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
export const DOT_WAKE_TOOLS: DotWakeTool[] = [];
export const DOT_STATUS_SECTIONS: DotStatusSection[] = [];
export const DOT_DIGEST_SECTIONS: DotDigestSection[] = [];
