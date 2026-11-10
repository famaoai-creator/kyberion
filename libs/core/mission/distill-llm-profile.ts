import { logger } from '../core.js';
import { getRegisteredEnvText } from '../foundation/env.js';

let warnedLegacyDistillProfileEnv = false;

/**
 * The LLM profile override for mission distillation. `KYBERION_DISTILL_LLM_PROFILE`
 * is canonical (D8 / M3: "wisdom" names the actuator only);
 * `KYBERION_WISDOM_LLM_PROFILE` is still accepted for one release with a
 * deprecation warning when the new name is unset.
 */
export function distillLlmProfileOverride(): string | undefined {
  const current = getRegisteredEnvText('KYBERION_DISTILL_LLM_PROFILE')?.trim();
  if (current) return current;
  const legacy = getRegisteredEnvText('KYBERION_WISDOM_LLM_PROFILE')?.trim();
  if (!legacy) return undefined;
  if (!warnedLegacyDistillProfileEnv) {
    warnedLegacyDistillProfileEnv = true;
    logger.warn(
      `KYBERION_WISDOM_LLM_PROFILE is deprecated — read as KYBERION_DISTILL_LLM_PROFILE=${legacy}; it stops being read next release | next: set KYBERION_DISTILL_LLM_PROFILE=${legacy} and unset KYBERION_WISDOM_LLM_PROFILE | evidence: knowledge/product/governance/env-registry.json`
    );
  }
  return legacy;
}
