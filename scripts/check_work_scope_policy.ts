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
} from '@agent/core/work-scope-decision';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function collectWorkScopePolicyViolations(policy: WorkScopePolicy): string[] {
  const derivable = new Set<string>(DERIVABLE_MANDATORY_TRIGGER_IDS);
  return policy.mandatory_triggers
    .filter((trigger) => !derivable.has(trigger))
    .map(
      (trigger) =>
        `work-scope-policy: mandatory trigger "${trigger}" has no reachable emitter in work-scope-decision.ts`
    );
}

export const runCheckWorkScopePolicy = defineScript({
  name: 'check:work-scope-policy',
  flags: [],
  run(context) {
    const policy = loadWorkScopePolicy();
    const violations = collectWorkScopePolicyViolations(policy);
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }
    context.print(
      `[check:work-scope-policy] OK — ${policy.mandatory_triggers.length} mandatory trigger(s) are reachable`
    );
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_work_scope_policy.ts') ||
  isDirectScript(import.meta.url, 'check_work_scope_policy.js')
)
  void runCheckWorkScopePolicy();
