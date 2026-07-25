/**
 * SO-05: shared structured-log recorder for `model_tier` declarations.
 *
 * Originally `recordSurfaceReasoningTierDeclaration` lived privately inside
 * `surface-runtime-orchestrator.ts` and only covered the surface
 * conversation front (intent compile / main ask / summary ask — see
 * `surface-reasoning-tier-boundary.test.ts`). SO-05's back half extends the
 * same declaration discipline to orchestrator-JUDGMENT call sites (IL-04
 * completion reconciliation's LLM tightening pass, mission finish-time
 * reconciliation, and the mission-steering route) which live in
 * `intent-reconciliation.ts`, `mission-lifecycle.ts`, and
 * `surface-mission-steering.ts` — none of which should depend on
 * `surface-runtime-orchestrator.ts` (a much higher-level, conversation-front
 * module) just to log a tier declaration. Extracting the recorder here keeps
 * the log event shape identical for existing surface-front call sites while
 * letting foundational mission modules record through the same mechanism
 * without an inverted/circular dependency.
 */
import { createLogger } from './logger.js';

const reasoningTierLogger = createLogger('surface-reasoning-tier');

export interface ReasoningTierDeclarationInput {
  /** Free-form call-site label (e.g. `'surface_main_ask'`, `'intent_reconciliation_llm_tighten'`). */
  callSite: string;
  declaredTier: 'fast' | 'standard' | 'deep';
  escalatedReason?: string;
}

export function recordReasoningTierDeclaration(input: ReasoningTierDeclarationInput): void {
  reasoningTierLogger.info('surface_reasoning_tier_declared', {
    call_site: input.callSite,
    declared_tier: input.declaredTier,
    escalated: Boolean(input.escalatedReason),
    ...(input.escalatedReason ? { escalation_reason: input.escalatedReason } : {}),
  });
}
