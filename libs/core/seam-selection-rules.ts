/**
 * Operator seam selection rules — what a human decided after seeing the
 * providers side by side (see seam-calibration.ts).
 *
 * Two kinds of override live in `<profile>/onboarding/seam-selection-rules.json`
 * (personal tier, like voice-selection.json):
 *   - rules: "for this seam, when <purpose / context>, prefer these providers";
 *   - trait_overrides: measured trait values replacing the product policy's
 *     declared ones for a provider (basis `measured`, with evidence).
 *
 * The product policy (knowledge/product/governance/seam-provider-selection/)
 * stays the shared baseline; this file is one operator's judgment on top.
 */

import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { resolveActiveProfileRoot } from './profile-root.js';
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
    explicit || path.join(resolveActiveProfileRoot(), 'onboarding', 'seam-selection-rules.json'),
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

/** Load the operator overlay; missing or invalid files read as "no rules". */
export function loadSeamSelectionRules(): SeamSelectionRulesFile {
  try {
    const filePath = seamSelectionRulesPath();
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return { ...EMPTY, rules: [] };
    return catalogAt(filePath).load();
  } catch {
    return { ...EMPTY, rules: [] };
  }
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
  const file = loadSeamSelectionRules();
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
  const rules = file.rules.filter((existing) => existing.rule_id !== rule.rule_id);
  rules.push(rule);
  return { rule, path: saveSeamSelectionRules({ ...file, rules }) };
}

export function removeSeamSelectionRule(ruleId: string): boolean {
  const file = loadSeamSelectionRules();
  const rules = file.rules.filter((rule) => rule.rule_id !== ruleId);
  if (rules.length === file.rules.length) return false;
  saveSeamSelectionRules({ ...file, rules });
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
  const file = loadSeamSelectionRules();
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
  return saveSeamSelectionRules({ ...file, trait_overrides: overrides });
}
