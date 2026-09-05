import { listFallbacks } from '@agent/core/config-fallback-registry';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function findConfigFallbackViolations(): string[] {
  return listFallbacks()
    .filter((entry) => !entry.resolved || entry.occurrence_count > 0)
    .map(
      (entry) =>
        `${entry.knowledge_path}: ${entry.occurrence_count} fallback occurrence(s), resolved=${String(entry.resolved)}`
    );
}

export const runCheckConfigFallbacks = defineScript({
  name: 'check:config-fallbacks',
  flags: [],
  run(context) {
    const violations = findConfigFallbackViolations();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          `${violations.length} config fallback registry violation(s)`,
          ...violations.map((violation) => `- ${violation}`),
        ].join('\n')
      );
    }
    context.print('[check:config-fallbacks] OK (no recorded fallback occurrences)');
  },
});

if (
  isDirectScript(import.meta.url, 'check_config_fallbacks.ts') ||
  isDirectScript(import.meta.url, 'check_config_fallbacks.js')
)
  void runCheckConfigFallbacks();
