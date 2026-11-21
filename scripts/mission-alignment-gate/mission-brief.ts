/**
 * Canonical persisted mission-brief contract used by the alignment surfaces.
 *
 * A brief is intentionally a partial draft: all fields are optional so the
 * renderer can show an incomplete alignment without inventing content. The
 * schema still rejects unknown keys and malformed nested values before a brief
 * is hashed or used for an approval decision.
 */
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { t } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/foundation/locale-normalize';

export interface MissionBriefFlowStep {
  step?: string | number;
  title?: string;
  detail?: string;
  pipeline?: string;
}

export interface MissionBriefRisk {
  risk?: string;
  level?: string | number;
  mitigation?: string;
}

export interface MissionBriefRole {
  who?: string;
  role?: string;
}

export interface MissionBriefRequirementsGovernance {
  strictFraming?: boolean;
  requireUncertaintyFallback?: boolean;
  changeLevelRouting?: boolean;
  assumptions?: string[];
  maturityLevel?: number;
}

export interface MissionBriefFactoryDelivery {
  enabled?: boolean;
  branch?: string;
  mergeMode?: 'auto_low_risk' | 'veto_window' | 'human_only';
  maxCiRepairAttempts?: number;
  allowedPaths?: string[];
}

export interface MissionBrief {
  /** Hash-bound internal admission facts, never business-effect permission. */
  missionAdmission?: {
    mandate_ref: string;
    mandate_facts: import('@agent/core/governance/mandate-shadow').MissionMandateFacts;
  };
  missionId?: string;
  title?: string;
  intent?: string;
  persona?: string;
  tier?: 'personal' | 'confidential' | 'public' | string;
  sovereignSwitch?: 'governance-first' | 'autonomous-yolo' | string;
  victoryConditions?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: MissionBriefFlowStep[];
  roles?: MissionBriefRole[];
  deliverables?: string[];
  risks?: MissionBriefRisk[];
  openItems?: string[];
  gate?: {
    sudoGate?: string | boolean;
    riskLevel?: string | number;
    approvalRequired?: boolean;
  };
  estimate?: { effort?: string; cost?: string };
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackType?: string;
  lifecycleModel?: string;
  /** Where the brief was authored from (e.g. `{ kind: 'work_inventory', ref: <entry id> }`). */
  source?: { kind: string; ref: string; tenantSlug?: string };
  /** Opt-in requirements-management controls (strict framing, L1/L2/L3 routing, assumptions). */
  requirementsGovernance?: MissionBriefRequirementsGovernance;
  /** Optional Software Factory 1-shot delivery delegation bound to the brief hash. */
  factoryDelivery?: MissionBriefFactoryDelivery;
}

/** Same disclosure on every approval surface and the HTML brief. */
export function formatMissionAdmission(
  brief: MissionBrief,
  locale?: SupportedLocale
): string | undefined {
  const admission = brief.missionAdmission;
  if (!admission) return undefined;
  const facts = admission.mandate_facts;
  return t(
    'mission_alignment:admission_disclosure',
    {
      mandate: admission.mandate_ref,
      work: facts.work_type,
      paths: facts.paths.join(', '),
      cost: facts.estimated_cost,
      currency: facts.currency,
      risk: facts.risk_level,
      effects: JSON.stringify(facts.external_effects),
    },
    locale
  );
}

const MISSION_BRIEF_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-brief.schema.json'
);

/** Load a persisted mission brief through its schema and secure I/O boundary. */
export function loadMissionBriefAtPath(filePath: string): MissionBrief {
  return defineCatalog<MissionBrief>({
    id: 'mission-brief',
    path: filePath,
    schema: MISSION_BRIEF_SCHEMA_PATH,
  }).load();
}

export interface StrictBriefFramingValidation {
  ok: boolean;
  missing: string[];
  reasons: string[];
}

function nonEmptyStrings(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Determine whether opt-in strict requirements framing applies to this brief.
 * Explicit caller override wins; otherwise `brief.requirementsGovernance.strictFraming` triggers enforcement.
 */
export function isStrictRequirementsFramingEnabled(
  brief: MissionBrief,
  override?: boolean
): boolean {
  if (override !== undefined) return override;
  return brief.requirementsGovernance?.strictFraming === true;
}

/**
 * Validate IPA Problem/Goal & Scope framing fields required under opt-in strict alignment mode.
 */
export function validateStrictMissionBriefFraming(
  brief: MissionBrief
): StrictBriefFramingValidation {
  const missing: string[] = [];
  const reasons: string[] = [];

  if (typeof brief.intent !== 'string' || brief.intent.trim().length === 0) {
    missing.push('intent');
    reasons.push('intent (core objective statement) must be non-empty.');
  }
  if (nonEmptyStrings(brief.victoryConditions).length === 0) {
    missing.push('victoryConditions');
    reasons.push('victoryConditions must list at least one verifiable acceptance criterion.');
  }
  if (nonEmptyStrings(brief.scope?.in).length === 0) {
    missing.push('scope.in');
    reasons.push('scope.in must declare at least one explicit in-scope boundary.');
  }
  if (nonEmptyStrings(brief.scope?.out).length === 0) {
    missing.push('scope.out');
    reasons.push('scope.out must declare at least one explicit non-goal / out-of-scope boundary.');
  }
  if (nonEmptyStrings(brief.deliverables).length === 0) {
    missing.push('deliverables');
    reasons.push('deliverables must declare at least one expected output.');
  }
  const hasAssumptions = nonEmptyStrings(brief.requirementsGovernance?.assumptions).length > 0;
  const hasRisks = (brief.risks ?? []).some(
    (entry) => typeof entry?.risk === 'string' && entry.risk.trim().length > 0
  );
  if (!hasAssumptions && !hasRisks) {
    missing.push('assumptions_or_risks');
    reasons.push(
      'requirementsGovernance.assumptions or risks must record at least one assumption, premise, or risk.'
    );
  }

  return {
    ok: missing.length === 0,
    missing,
    reasons,
  };
}

const FACTORY_BRANCH_PATTERN = /^agent\/factory-[a-z0-9][a-z0-9-]{1,60}$/u;
const FACTORY_MERGE_MODES = new Set(['auto_low_risk', 'veto_window', 'human_only']);

function isSafeRepoRelativePattern(entry: unknown): boolean {
  if (typeof entry !== 'string') return false;
  if (entry !== entry.trim() || entry.length === 0) return false;
  if (entry.startsWith('/') || entry.includes('\\') || /\0|\s/u.test(entry)) return false;
  const cleaned = entry.replace(/^(?:\.\/)+/u, '');
  if (!cleaned) return false;
  const segments = cleaned.split('/');
  return !segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git'
  );
}

/** Validate 1-shot Software Factory delivery delegation when enabled on the brief. */
export function validateFactoryDeliveryConfig(brief: MissionBrief): {
  ok: boolean;
  reasons: string[];
} {
  const cfg = brief.factoryDelivery;
  if (cfg?.enabled !== true) return { ok: true, reasons: [] };

  const reasons: string[] = [];
  if (typeof cfg.branch !== 'string' || !FACTORY_BRANCH_PATTERN.test(cfg.branch)) {
    reasons.push(
      'factoryDelivery.branch must be present and match ^agent/factory-[a-z0-9][a-z0-9-]{1,60}$.'
    );
  }
  if (
    cfg.mergeMode !== undefined &&
    (typeof cfg.mergeMode !== 'string' || !FACTORY_MERGE_MODES.has(cfg.mergeMode))
  ) {
    reasons.push('factoryDelivery.mergeMode must be auto_low_risk, veto_window, or human_only.');
  }
  if (
    cfg.maxCiRepairAttempts !== undefined &&
    (!Number.isInteger(cfg.maxCiRepairAttempts) ||
      cfg.maxCiRepairAttempts < 0 ||
      cfg.maxCiRepairAttempts > 3)
  ) {
    reasons.push('factoryDelivery.maxCiRepairAttempts must be an integer between 0 and 3.');
  }
  if (
    !Array.isArray(cfg.allowedPaths) ||
    cfg.allowedPaths.length === 0 ||
    cfg.allowedPaths.some((entry) => !isSafeRepoRelativePattern(entry))
  ) {
    reasons.push(
      'factoryDelivery.allowedPaths must be a non-empty array of safe repo-relative paths or globs.'
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/** Format human-readable disclosure of 1-shot factory delegation for approval cards. */
export function formatFactoryDelivery(brief: MissionBrief): string | undefined {
  const cfg = brief.factoryDelivery;
  if (cfg?.enabled !== true) return undefined;
  return [
    'Factory Delivery Delegation:',
    `- branch: ${cfg.branch ?? '(unset)'}`,
    `- mergeMode: ${cfg.mergeMode ?? 'veto_window'}`,
    `- maxCiRepairAttempts: ${cfg.maxCiRepairAttempts ?? 3}`,
    `- allowedPaths: ${(cfg.allowedPaths ?? []).join(', ') || '(none)'}`,
  ].join('\n');
}
