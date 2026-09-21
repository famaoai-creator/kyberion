/**
 * Operator seam selection rules — what a human decided after seeing the
 * providers side by side (see seam-calibration.ts).
 *
 * Two kinds of override live in `active/shared/runtime/seam-selection/rules.json`
 * (KYBERION_SEAM_SELECTION_RULES_PATH overrides it for direct / test use):
 *   - rules: "for this seam, when <purpose / context>, prefer these providers";
 *   - trait_overrides: measured trait values replacing the product policy's
 *     declared ones for a provider (basis `measured`, with evidence).
 *
 * The product policy (knowledge/product/governance/seam-provider-selection/)
 * stays the shared baseline; this file is the operator's judgment on top.
 *
 * Why shared runtime storage and not the personal profile: every runtime role
 * that selects a provider (worker, surface_runtime, …) must be able to read
 * the rules, and the personal tier is not readable by them — rules there were
 * silently ignored at run time. Rules hold provider preferences and measured
 * numbers, not personal data. They can only reorder providers that already
 * passed each seam's hard filter (egress, identity, capabilities), and every
 * change is written to the audit chain.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { logger } from './core.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { withLockSync } from './src/lock-utils.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export interface SeamSelectionRuleCondition {
  purpose?: string;
  /** Exact-match request context, e.g. { language: 'ja' }. */
  context?: Record<string, string>;
}

export interface SeamSelectionRule {
  rule_id: string;
  seam: string;
  when: SeamSelectionRuleCondition;
  /** Providers in preference order; ineligible ones are skipped. */
  prefer: string[];
  note?: string;
  evidence?: string[];
  set_by: string;
  set_at: string;
}

export interface SeamTraitOverride {
  traits: Record<string, number>;
  evidence?: string[];
  set_by: string;
  set_at: string;
}

export interface SeamSelectionRulesFile {
  version: '1.0.0';
  rules: SeamSelectionRule[];
  trait_overrides?: Record<string, Record<string, SeamTraitOverride>>;
  updated_at?: string;
}

const RULES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/seam-selection-rules.schema.json'
);

export function seamSelectionRulesPath(): string {
  const explicit = getRegisteredEnvText('KYBERION_SEAM_SELECTION_RULES_PATH')?.trim();
  return assertSafeRepositoryPath(
    explicit || pathResolver.rootResolve('active/shared/runtime/seam-selection/rules.json'),
    { allowMissingLeaf: true }
  );
}

function catalogAt(filePath: string) {
  return defineCatalog<SeamSelectionRulesFile>({
    id: 'seam-selection-rules',
    path: filePath,
    schema: RULES_SCHEMA_PATH,
  });
}

const EMPTY: SeamSelectionRulesFile = { version: '1.0.0', rules: [] };

let warnedLoadFailure = false;

/**
 * Load the operator overlay. A missing file means "no rules"; an unreadable or
 * invalid one also yields no rules (selection must not break) but is warned
 * about once per process so it is never silently ignored.
 */
export function loadSeamSelectionRules(): SeamSelectionRulesFile {
  let filePath = '';
  try {
    filePath = seamSelectionRulesPath();
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return { ...EMPTY, rules: [] };
    return catalogAt(filePath).load();
  } catch (error: unknown) {
    if (!warnedLoadFailure) {
      warnedLoadFailure = true;
      logger.warn(
        `[seam-selection-rules] ignoring operator rules at ${filePath || 'unknown path'}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return { ...EMPTY, rules: [] };
  }
}

function recordRuleChange(operation: string, detail: Record<string, unknown>): void {
  auditChain.record({
    agentId: actor(),
    action: 'seam_selection_rule_change',
    operation,
    result: 'completed',
    metadata: detail,
  });
}

function saveSeamSelectionRules(file: SeamSelectionRulesFile): string {
  const filePath = seamSelectionRulesPath();
  const next: SeamSelectionRulesFile = { ...file, version: '1.0.0', updated_at: nowIso() };
  catalogAt(filePath).validate(next, filePath);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
  return filePath;
}

function updateSeamSelectionRules(
  mutator: (file: SeamSelectionRulesFile) => SeamSelectionRulesFile | null
): { filePath: string; file: SeamSelectionRulesFile; changed: boolean } {
  const filePath = seamSelectionRulesPath();
  const lockId = `seam-selection-rules-${createHash('sha256')
    .update(filePath, 'utf8')
    .digest('hex')}`;
  return withLockSync(lockId, () => {
    const file = loadSeamSelectionRules();
    const next = mutator(file);
    if (!next) return { filePath, file, changed: false };
    saveSeamSelectionRules(next);
    return { filePath, file: next, changed: true };
  });
}

export function listSeamSelectionRules(seam?: string): SeamSelectionRule[] {
  const rules = loadSeamSelectionRules().rules;
  return seam ? rules.filter((rule) => rule.seam === seam) : rules;
}

export function hasSeamSelectionRules(seam: string): boolean {
  return listSeamSelectionRules(seam).length > 0;
}

function conditionSize(when: SeamSelectionRuleCondition): number {
  return (when.purpose ? 1 : 0) + Object.keys(when.context ?? {}).length;
}

/**
 * The rule that applies to a request: every condition must match exactly;
 * the most specific rule wins, then the most recently set one.
 */
export function matchSeamSelectionRule(
  seam: string,
  request: { purpose?: string; context?: Record<string, string> }
): SeamSelectionRule | null {
  const context = request.context ?? {};
  const matching = listSeamSelectionRules(seam).filter((rule) => {
    if (rule.when.purpose && rule.when.purpose !== request.purpose) return false;
    return Object.entries(rule.when.context ?? {}).every(([key, value]) => context[key] === value);
  });
  matching.sort(
    (a, b) => conditionSize(b.when) - conditionSize(a.when) || b.set_at.localeCompare(a.set_at)
  );
  return matching[0] ?? null;
}

function actor(): string {
  return (
    getRegisteredEnvText('KYBERION_PERSONA') || getRegisteredEnvText('MISSION_ROLE') || 'operator'
  );
}

export function setSeamSelectionRule(input: {
  rule_id: string;
  seam: string;
  when: SeamSelectionRuleCondition;
  prefer: string[];
  note?: string;
  evidence?: string[];
  set_by?: string;
}): { rule: SeamSelectionRule; path: string } {
  const rule: SeamSelectionRule = {
    rule_id: input.rule_id,
    seam: input.seam,
    when: {
      ...(input.when.purpose ? { purpose: input.when.purpose } : {}),
      ...(input.when.context && Object.keys(input.when.context).length > 0
        ? { context: input.when.context }
        : {}),
    },
    prefer: input.prefer,
    ...(input.note ? { note: input.note } : {}),
    ...(input.evidence?.length ? { evidence: input.evidence } : {}),
    set_by: input.set_by || actor(),
    set_at: nowIso(),
  };
  const { filePath } = updateSeamSelectionRules((file) => ({
    ...file,
    rules: [...file.rules.filter((existing) => existing.rule_id !== rule.rule_id), rule],
  }));
  recordRuleChange(`set:${rule.seam}/${rule.rule_id}`, { rule });
  return { rule, path: filePath };
}

export function removeSeamSelectionRule(ruleId: string): boolean {
  const { changed } = updateSeamSelectionRules((file) => {
    const rules = file.rules.filter((rule) => rule.rule_id !== ruleId);
    return rules.length === file.rules.length ? null : { ...file, rules };
  });
  if (!changed) return false;
  recordRuleChange(`remove:${ruleId}`, { rule_id: ruleId });
  return true;
}

export function getSeamTraitOverrides(seam: string): Record<string, SeamTraitOverride> {
  return loadSeamSelectionRules().trait_overrides?.[seam] ?? {};
}

/** Record measured trait values for providers of a seam (merged per trait). */
export function setSeamTraitOverrides(input: {
  seam: string;
  values: Record<string, Record<string, number>>;
  evidence?: string[];
  set_by?: string;
}): string {
  const { filePath } = updateSeamSelectionRules((file) => {
    const overrides = { ...(file.trait_overrides ?? {}) };
    const seamOverrides = { ...(overrides[input.seam] ?? {}) };
    for (const [providerId, traits] of Object.entries(input.values)) {
      const previous = seamOverrides[providerId];
      seamOverrides[providerId] = {
        traits: { ...(previous?.traits ?? {}), ...traits },
        ...(input.evidence?.length ? { evidence: input.evidence } : {}),
        set_by: input.set_by || actor(),
        set_at: nowIso(),
      };
    }
    overrides[input.seam] = seamOverrides;
    return { ...file, trait_overrides: overrides };
  });
  recordRuleChange(`measured-traits:${input.seam}`, {
    seam: input.seam,
    values: input.values,
    evidence: input.evidence,
  });
  return filePath;
}
