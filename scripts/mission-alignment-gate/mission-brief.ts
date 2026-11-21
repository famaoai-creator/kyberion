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
