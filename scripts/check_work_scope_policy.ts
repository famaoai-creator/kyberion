/**
 * Verify that every mandatory trigger declared by the work-scope policy has
 * a reachable emitter in the decision layer.
 *
 * This is intentionally a small policy/code boundary check: adding a policy
 * trigger without adding an explicit input path must fail before deployment.
 */
import {
  DERIVABLE_MANDATORY_TRIGGER_IDS,
  loadWorkScopePolicy,
  type WorkScopePolicy,
} from '@agent/core';

export function collectWorkScopePolicyViolations(policy: WorkScopePolicy): string[] {
  const derivable = new Set<string>(DERIVABLE_MANDATORY_TRIGGER_IDS);
  return policy.mandatory_triggers
    .filter((trigger) => !derivable.has(trigger))
    .map(
      (trigger) =>
        `work-scope-policy: mandatory trigger "${trigger}" has no reachable emitter in work-scope-decision.ts`
    );
}

export function main(): void {
  const policy = loadWorkScopePolicy();
  const violations = collectWorkScopePolicyViolations(policy);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`[check:work-scope-policy] ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[check:work-scope-policy] OK — ${policy.mandatory_triggers.length} mandatory trigger(s) are reachable`
  );
}

if (process.argv[1]?.endsWith('check_work_scope_policy.ts')) main();
