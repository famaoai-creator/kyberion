import * as path from 'node:path';
import { isVitestProcess } from '../foundation/env.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import { matchHighRiskPaths } from './autonomous-ops-gate.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  readTenantGovernanceOverlays,
  type TenantGovernanceOverlay,
} from '../organization/tenant-governance-overlay.js';

const logger = createLogger('mandate-shadow');

/**
 * Autonomous-operation P4 in shadow mode: for every mission brief that goes to
 * the operator for plan approval, record whether a standing mandate (包括委任)
 * WOULD have covered it, then compare with what the operator decided.
 *
 * This is record-only. It never approves, skips or alters the plan gate, which
 * stays `human_only`; it only produces the agreement evidence needed to decide
 * later whether `mission_start_mandate` may leave shadow mode. A mandate never
 * covers a brief unless every condition holds, and any doubt means "not covered".
 */

export interface StandingMandate {
  id: string;
  title: string;
  work_type_patterns: string[];
  allowed_path_globs: string[];
  max_risk_level: number;
  expires_at: string;
  /** Explicit internal admission authority; absence retains shadow-only semantics. */
  authority?: {
    tenant_slug: string;
    status: 'active' | 'revoked';
    max_cost: number;
    currency: string;
    allowed_external_effects: string[];
  };
}

export interface MissionAdmissionRequest {
  mandate_ref: string;
  mandate_facts: MissionMandateFacts;
}

export function parseMissionAdmissionRequest(value: unknown): MissionAdmissionRequest | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid mission_admission');
  const raw = value as Record<string, unknown>;
  const facts = raw.mandate_facts as MissionMandateFacts | undefined;
  if (
    typeof raw.mandate_ref !== 'string' ||
    !raw.mandate_ref.trim() ||
    !facts ||
    typeof facts.work_type !== 'string' ||
    !facts.work_type.trim() ||
    !Array.isArray(facts.paths) ||
    !facts.paths.length ||
    facts.paths.some((p) => typeof p !== 'string') ||
    typeof facts.estimated_cost !== 'number' ||
    !Number.isFinite(facts.estimated_cost) ||
    facts.estimated_cost < 0 ||
    typeof facts.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(facts.currency) ||
    !Array.isArray(facts.external_effects) ||
    facts.external_effects.some((e) => typeof e !== 'string' || !e.trim()) ||
    !Number.isInteger(facts.risk_level) ||
    facts.risk_level < 0 ||
    facts.risk_level > 5
  )
    throw new Error('invalid mission_admission facts');
  return {
    mandate_ref: raw.mandate_ref,
    mandate_facts: {
      work_type: facts.work_type,
      paths: [...facts.paths],
      estimated_cost: facts.estimated_cost,
      currency: facts.currency,
      external_effects: [...facts.external_effects],
      risk_level: facts.risk_level,
    },
  };
}

export interface MissionMandateFacts {
  work_type: string;
  paths: string[];
  estimated_cost: number;
  currency: string;
  external_effects: string[];
  risk_level: number;
}

/** Internal mission admission only. This never authorizes a business effect. */
export function evaluateMissionStartMandate(
  input: { tenant_slug: string; mandate_id: unknown; facts: unknown },
  options: { catalog?: MandateCatalog; now?: Date } = {}
): MandateEvaluation {
  const deny = (reason: string): MandateEvaluation => ({ covered: false, reasons: [reason] });
  if (!isValidTenantSlug(input.tenant_slug) || typeof input.mandate_id !== 'string')
    return deny('tenant and exact mandate id required');
  const catalog = options.catalog ?? loadMandateCatalog();
  const mandate = catalog.mandates.find((entry) => entry.id === input.mandate_id);
  const authority = mandate?.authority;
  if (
    !mandate ||
    !authority ||
    authority.status !== 'active' ||
    authority.tenant_slug !== input.tenant_slug
  )
    return deny('no active tenant-bound admission authority');
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(Date.parse(mandate.expires_at)) || Date.parse(mandate.expires_at) <= now)
    return deny('mandate expired or invalid');
  const f = input.facts as Partial<MissionMandateFacts> | null;
  if (
    !f ||
    typeof f !== 'object' ||
    Array.isArray(f) ||
    typeof f.work_type !== 'string' ||
    !f.work_type.trim() ||
    !Array.isArray(f.paths) ||
    !f.paths.length ||
    f.paths.some(
      (p) =>
        typeof p !== 'string' ||
        !p ||
        /\s/.test(p) ||
        p.includes('\\') ||
        p.startsWith('/') ||
        p.split('/').some((s) => s === '..' || s === '.') ||
        /[*?\[\]{}]/.test(p)
    ) ||
    typeof f.estimated_cost !== 'number' ||
    !Number.isFinite(f.estimated_cost) ||
    f.estimated_cost < 0 ||
    typeof f.currency !== 'string' ||
    !Array.isArray(f.external_effects) ||
    f.external_effects.some((e) => typeof e !== 'string' || !e.trim()) ||
    typeof f.risk_level !== 'number' ||
    !Number.isInteger(f.risk_level) ||
    f.risk_level < 0
  )
    return deny('trusted typed admission facts required');
  if (
    !Number.isFinite(authority.max_cost) ||
    authority.max_cost < 0 ||
    f.estimated_cost > authority.max_cost ||
    f.currency !== authority.currency
  )
    return deny('cost outside mandate');
  if (f.external_effects.some((effect) => !authority.allowed_external_effects.includes(effect)))
    return deny('external effect outside mandate');
  // Reuse settled work-type/risk/path/expiry checks, constrained to the exact
  // authority above. Explicit effects are checked separately, never inferred.
  return evaluateBriefAgainstMandates(
    { title: f.work_type, scope: { in: f.paths }, gate: { riskLevel: f.risk_level } },
    { catalog: { ...catalog, external_effect_patterns: [], mandates: [mandate] }, now: options.now }
  );
}

export interface MandateCatalog {
  version: string;
  external_effect_patterns: string[];
  mandates: StandingMandate[];
}

/** The slice of a mission brief the evaluator reads (a structural subset of MissionBrief). */
export interface MandateBriefInput {
  title?: string;
  intent?: string;
  tier?: string;
  deliverables?: string[];
  scope?: { in?: string[]; out?: string[] };
  flow?: Array<{ title?: string; detail?: string }>;
  gate?: { riskLevel?: string | number };
}

export interface MandateEvaluation {
  covered: boolean;
  mandate_id?: string;
  /** Why not covered (empty when covered), or what matched. */
  reasons: string[];
}

const CATALOG_REL = 'product/governance/standing-mandates.json';
/** Tenant-owned mandates: `knowledge/confidential/<slug>/governance/<this file>`. */
export const TENANT_MANDATE_OVERLAY_FILE = 'standing-mandates.json';

function mandateCatalog() {
  return defineCatalog<MandateCatalog>({
    id: 'standing-mandates',
    path: pathResolver.knowledge(CATALOG_REL),
    schema: pathResolver.knowledge('product/schemas/standing-mandates.schema.json'),
  });
}

/**
 * Merge tenant overlay files (`{version, mandates}`; `external_effect_patterns`
 * stays product-owned) into `catalog`. Every overlay mandate must carry an
 * `authority` bound to its directory tenant, and its id may not reuse a
 * product mandate id or an id another overlay entry also declares (every
 * claimant is dropped). An invalid file drops that tenant's overlay only.
 */
export function mergeTenantMandateOverlays(
  catalog: MandateCatalog,
  overlays: readonly TenantGovernanceOverlay[]
): MandateCatalog {
  const validator = mandateCatalog();
  const productIds = new Set(catalog.mandates.map((mandate) => mandate.id));
  const candidates: Array<{ slug: string; mandate: StandingMandate }> = [];
  for (const overlay of overlays) {
    let mandates: StandingMandate[];
    try {
      if (overlay.error) throw new Error(overlay.error);
      const value = overlay.value;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('overlay must be a JSON object');
      if ('external_effect_patterns' in value)
        throw new Error('external_effect_patterns is product-owned; remove it from the overlay');
      mandates = validator.validate(
        { ...value, external_effect_patterns: [] },
        overlay.path
      ).mandates;
    } catch (error) {
      logger.warn(
        `tenant ${overlay.tenant_slug} standing mandate overlay ignored — invalid file | next: fix ${overlay.path} | evidence: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    for (const mandate of mandates) {
      if (mandate.authority?.tenant_slug !== overlay.tenant_slug) {
        logger.warn(
          `tenant ${overlay.tenant_slug} mandate '${mandate.id}' dropped — its authority is not bound to this tenant | next: set authority.tenant_slug to '${overlay.tenant_slug}' in ${overlay.path} | evidence: authority.tenant_slug=${mandate.authority?.tenant_slug ?? 'missing'}`
        );
        continue;
      }
      if (productIds.has(mandate.id)) {
        logger.warn(
          `tenant ${overlay.tenant_slug} mandate '${mandate.id}' dropped — the id is a product mandate | next: rename it in ${overlay.path} | evidence: knowledge/${CATALOG_REL}`
        );
        continue;
      }
      candidates.push({ slug: overlay.tenant_slug, mandate });
    }
  }
  const merged = [...catalog.mandates];
  for (const candidate of candidates) {
    const claimants = candidates.filter((other) => other.mandate.id === candidate.mandate.id);
    if (claimants.length > 1) {
      logger.warn(
        `tenant ${candidate.slug} mandate '${candidate.mandate.id}' dropped — the id is declared more than once | next: give each tenant mandate a distinct id | evidence: ${claimants.map((other) => other.slug).join(', ')}`
      );
      continue;
    }
    merged.push(candidate.mandate);
  }
  return { ...catalog, mandates: merged };
}

/**
 * Product catalog plus, unless `tenantOverlays` is false, every registered
 * tenant's overlay mandates ({@link mergeTenantMandateOverlays}).
 */
export function loadMandateCatalog(
  options: { tenantOverlays?: boolean; rootDir?: string } = {}
): MandateCatalog {
  const catalog = mandateCatalog().load();
  if (options.tenantOverlays === false) return catalog;
  return mergeTenantMandateOverlays(
    catalog,
    readTenantGovernanceOverlays(TENANT_MANDATE_OVERLAY_FILE, { rootDir: options.rootDir })
  );
}

function riskLevelOf(brief: MandateBriefInput): number {
  const level = brief.gate?.riskLevel;
  if (typeof level === 'number') return level;
  const parsed = typeof level === 'string' ? Number.parseInt(level, 10) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  // Unknown or word levels ("high", "critical") count as above any mandate's ceiling.
  return typeof level === 'string' && /^(low)$/iu.test(level.trim()) ? 1 : 99;
}

function textOf(brief: MandateBriefInput): string {
  return [
    brief.title,
    brief.intent,
    ...(brief.deliverables ?? []),
    ...(brief.flow ?? []).flatMap((step) => [step.title, step.detail]),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

/** Scope entries that name files or directories (everything else is prose). */
function pathScopeOf(brief: MandateBriefInput): string[] {
  return (brief.scope?.in ?? [])
    .map((entry) => entry.trim())
    .filter(
      (entry) => entry !== '' && /[/\\]|\.[a-z0-9]{1,5}$/iu.test(entry) && !/\s/u.test(entry)
    );
}

export function evaluateBriefAgainstMandates(
  brief: MandateBriefInput,
  options: { catalog?: MandateCatalog; now?: Date } = {}
): MandateEvaluation {
  // Shadow briefs carry no tenant, so tenant overlay mandates never cover them.
  const catalog = options.catalog ?? loadMandateCatalog({ tenantOverlays: false });
  const now = (options.now ?? new Date()).getTime();
  const text = textOf(brief);
  const reasons: string[] = [];

  if (brief.tier === 'personal') reasons.push('personal tier is never delegated');
  const external = catalog.external_effect_patterns.filter((p) => text.includes(p.toLowerCase()));
  if (external.length) reasons.push(`external effect: ${external.join(', ')}`);
  const paths = pathScopeOf(brief);
  if (!paths.length) reasons.push('no file scope declared');
  if (reasons.length) return { covered: false, reasons };

  const level = riskLevelOf(brief);
  const candidates = catalog.mandates.filter((mandate) =>
    mandate.work_type_patterns.some((p) => text.includes(p.toLowerCase()))
  );
  if (!candidates.length) return { covered: false, reasons: ['no mandate matches the work type'] };

  const misses: string[] = [];
  for (const mandate of candidates) {
    if (Date.parse(mandate.expires_at) <= now) {
      misses.push(`${mandate.id}: expired`);
    } else if (level > mandate.max_risk_level) {
      misses.push(`${mandate.id}: risk level ${level} above ${mandate.max_risk_level}`);
    } else if (matchHighRiskPaths(paths, mandate.allowed_path_globs).length !== paths.length) {
      misses.push(`${mandate.id}: scope outside allowed paths`);
    } else {
      return { covered: true, mandate_id: mandate.id, reasons: [] };
    }
  }
  return { covered: false, reasons: misses };
}

export interface MandateObservation {
  kind: 'observation';
  ts: string;
  mission_id: string;
  covered: boolean;
  mandate_id?: string;
  reasons: string[];
}

export interface MandateOutcome {
  kind: 'outcome';
  ts: string;
  mission_id: string;
  verdict: 'approved' | 'rejected';
}

export type MandateShadowRecord = MandateObservation | MandateOutcome;

let configuredRoot: string | null | undefined;

/** Point the ledger elsewhere (tests); `null` disables it. Under vitest it writes nothing by default. */
export function configureMandateShadowRoot(root: string | null | undefined): void {
  configuredRoot = root;
}

function ledgerFile(): string | null {
  const root =
    configuredRoot !== undefined
      ? configuredRoot
      : isVitestProcess()
        ? null
        : pathResolver.shared('runtime/mandate-shadow');
  if (!root) return null;
  if (!safeExistsSync(root)) safeMkdir(root, { recursive: true });
  return assertSafeRepositoryPath(path.join(root, 'ledger.jsonl'), { allowMissingLeaf: true });
}

export function listMandateShadowRecords(): MandateShadowRecord[] {
  const file = ledgerFile();
  if (!file) return [];
  return readJsonLines<MandateShadowRecord>(file, {
    onMalformed: 'skip',
    map: (value) => value as MandateShadowRecord,
  }).filter((r) => r && (r.kind === 'observation' || r.kind === 'outcome'));
}

function append(record: MandateShadowRecord): boolean {
  try {
    const file = ledgerFile();
    if (!file) return false;
    appendJsonLine(file, record);
    return true;
  } catch (error) {
    logger.warn(
      `mandate shadow record not written — ${error instanceof Error ? error.message : String(error)} | next: check active/shared/runtime/mandate-shadow is writable`
    );
    return false;
  }
}

/** Record what a mandate would have done for this brief. Never throws; never changes the gate. */
export function observeMandateCoverage(
  missionId: string,
  brief: MandateBriefInput,
  now: Date = new Date()
): MandateEvaluation | null {
  try {
    const evaluation = evaluateBriefAgainstMandates(brief, { now });
    append({
      kind: 'observation',
      ts: now.toISOString(),
      mission_id: missionId,
      covered: evaluation.covered,
      ...(evaluation.mandate_id ? { mandate_id: evaluation.mandate_id } : {}),
      reasons: evaluation.reasons,
    });
    return evaluation;
  } catch (error) {
    logger.warn(
      `mandate coverage not evaluated — ${error instanceof Error ? error.message : String(error)} | next: check standing-mandates.json`
    );
    return null;
  }
}

/** Record the operator's decision once per mission, and only for missions that were observed. */
export function recordMandateOutcome(
  missionId: string,
  verdict: 'approved' | 'rejected',
  now: Date = new Date()
): boolean {
  try {
    const records = listMandateShadowRecords();
    if (!records.some((r) => r.kind === 'observation' && r.mission_id === missionId)) return false;
    if (records.some((r) => r.kind === 'outcome' && r.mission_id === missionId)) return false;
    return append({ kind: 'outcome', ts: now.toISOString(), mission_id: missionId, verdict });
  } catch {
    return false;
  }
}

export interface MandateShadowSummary {
  observed: number;
  settled: number;
  /** Covered and the operator approved. */
  agreed: number;
  /** Covered but the operator rejected: the dangerous disagreement. */
  false_positive: number;
  /** Not covered although the operator approved: lost coverage, harmless. */
  missed: number;
  by_mandate: Record<string, { agreed: number; false_positive: number }>;
  readiness: string;
}

export const MANDATE_EXIT_MIN_SAMPLES = 20;

export function summarizeMandateShadow(
  records: readonly MandateShadowRecord[]
): MandateShadowSummary {
  const observations = new Map<string, MandateObservation>();
  const outcomes = new Map<string, MandateOutcome>();
  for (const record of records) {
    if (record.kind === 'observation') observations.set(record.mission_id, record);
    else outcomes.set(record.mission_id, record);
  }
  const summary: MandateShadowSummary = {
    observed: observations.size,
    settled: 0,
    agreed: 0,
    false_positive: 0,
    missed: 0,
    by_mandate: {},
    readiness: '',
  };
  for (const [missionId, observation] of observations) {
    const outcome = outcomes.get(missionId);
    if (!outcome) continue;
    summary.settled += 1;
    if (observation.covered) {
      const row = (summary.by_mandate[observation.mandate_id ?? 'unknown'] ??= {
        agreed: 0,
        false_positive: 0,
      });
      if (outcome.verdict === 'approved') {
        summary.agreed += 1;
        row.agreed += 1;
      } else {
        summary.false_positive += 1;
        row.false_positive += 1;
      }
    } else if (outcome.verdict === 'approved') {
      summary.missed += 1;
    }
  }
  const covered = summary.agreed + summary.false_positive;
  summary.readiness =
    summary.false_positive > 0
      ? `blocked: ${summary.false_positive} covered mission(s) were rejected — narrow the mandate`
      : covered < MANDATE_EXIT_MIN_SAMPLES
        ? `${covered}/${MANDATE_EXIT_MIN_SAMPLES} covered missions settled, 0 false positives so far`
        : `bar met (${covered} covered missions, 0 false positives) — operator may decide to leave shadow mode`;
  return summary;
}
