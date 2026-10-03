import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonValueFile } from './lib/json-input.js';

const VALID_EFFECTS = new Set(['read', 'write', 'egress', 'none']);

export interface OpEffectViolation {
  manifest: string;
  op: string;
  issue: string;
}

export function findOpEffectViolations(): OpEffectViolation[] {
  const actuatorsDir = assertSafeRepositoryPath(pathResolver.rootResolve('libs/actuators'));
  const violations: OpEffectViolation[] = [];
  for (const entry of safeReaddir(actuatorsDir)) {
    const manifestPath = `${actuatorsDir}/${entry}/manifest.json`;
    let manifest: Record<string, unknown>;
    try {
      manifest = readSafeJsonValueFile<Record<string, unknown>>(
        assertSafeRepositoryPath(manifestPath),
        `op effect coverage ${manifestPath}`
      );
    } catch {
      continue;
    }
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    for (const capability of capabilities) {
      if (!capability || typeof capability !== 'object') continue;
      const record = capability as Record<string, unknown>;
      const op = typeof record.op === 'string' ? record.op : '(unnamed)';
      const rel = manifestPath.replace(`${pathResolver.rootDir()}/`, '');
      const effect = record.effect;
      if (effect === undefined) {
        violations.push({ manifest: rel, op, issue: 'missing effect declaration' });
      } else if (!VALID_EFFECTS.has(effect as string)) {
        violations.push({ manifest: rel, op, issue: `invalid effect '${String(effect)}'` });
      }
      for (const key of ['effect_from', 'resource_ref_from'] as const) {
        const value = record[key];
        if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
          violations.push({ manifest: rel, op, issue: `${key} must be a non-empty string` });
        }
      }
    }
  }
  return violations;
}

export const runCheckOpEffectCoverage = defineScript({
  name: 'check:op-effect-coverage',
  flags: [],
  run(context) {
    const violations = findOpEffectViolations();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          `FAILED (${violations.length} violation(s))`,
          ...violations.map(
            (violation) => `- ${violation.manifest} ${violation.op}: ${violation.issue}`
          ),
        ].join('\n')
      );
    }
    context.print('[check:op-effect-coverage] OK (all manifest capabilities declare an effect)');
    return violations;
  },
});

if (
  isDirectScript(import.meta.url, 'check_op_effect_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_op_effect_coverage.js')
)
  void runCheckOpEffectCoverage();
