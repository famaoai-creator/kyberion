import { createHash } from 'node:crypto';
import { isValidTenantSlug } from '../entity-scope.js';
import { resolveMissionDevelopmentBranch } from '../vcs/development-branch.js';
import {
  getAutonomousOpsPolicy,
  matchHighRiskPaths,
  type AutonomousOpsPolicy,
} from './autonomous-ops-gate.js';
import {
  evaluateBriefAgainstMandates,
  loadMandateCatalog,
  type MandateBriefInput,
  type MandateCatalog,
} from './mandate-shadow.js';
import { LOW_RISK_GLOBS } from './pr-shadow.js';

export type FactoryEnvelopeAuthorityKind = 'standing_mandate' | 'alignment_brief';
export type FactoryMergeMode = 'auto_low_risk' | 'veto_window' | 'human_only';

export interface FactoryDeliveryEnvelopeInput {
  mission_id: string;
  tenant_slug?: string;
  authority_kind: FactoryEnvelopeAuthorityKind;
  mandate_id?: string;
  alignment_approval_ref?: string;
  development_branch: string;
  scope_in: string[];
  scope_out?: string[];
  allowed_paths: string[];
  max_ci_repair_attempts?: number;
  merge_mode: FactoryMergeMode;
  issued_at?: string;
}

export interface FactoryDeliveryEnvelope {
  version: 1;
  mission_id: string;
  tenant_slug?: string;
  authority_kind: FactoryEnvelopeAuthorityKind;
  mandate_id?: string;
  alignment_approval_ref?: string;
  development_branch: string;
  scope_in: readonly string[];
  scope_out: readonly string[];
  allowed_paths: readonly string[];
  max_ci_repair_attempts: number;
  merge_mode: FactoryMergeMode;
  issued_at: string;
  envelope_sha256: string;
}

export type FactoryEnvelopeDiffViolationCode =
  'integrity_mismatch' | 'empty_diff' | 'high_risk_path' | 'scope_out' | 'outside_allowed_paths';

export interface FactoryEnvelopeDiffViolation {
  code: FactoryEnvelopeDiffViolationCode;
  detail: string;
  paths: string[];
}

export interface FactoryEnvelopeDiffCheckInput {
  envelope: FactoryDeliveryEnvelope;
  changed_paths: string[];
  policy?: AutonomousOpsPolicy;
}

export interface FactoryEnvelopeDiffCheckResult {
  ok: boolean;
  violations: FactoryEnvelopeDiffViolation[];
  recommended_merge_mode: FactoryMergeMode;
  high_risk_matches: string[];
  scope_out_matches: string[];
  outside_allowed_paths: string[];
}

const MERGE_MODES = new Set<FactoryMergeMode>(['auto_low_risk', 'veto_window', 'human_only']);
const SHA256_RE = /^[a-f0-9]{64}$/u;

function normalizePattern(raw: string, label: string): string {
  if (typeof raw !== 'string') throw new Error(`Invalid ${label}: must be a string`);
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/u, '');
  if (!cleaned) throw new Error(`Invalid ${label}: empty entry`);
  if (cleaned.startsWith('/') || /\0|\s/u.test(cleaned)) {
    throw new Error(`Invalid ${label} "${raw}": must be a safe repo-relative path or glob`);
  }
  const segments = cleaned.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.git')) {
    throw new Error(`Invalid ${label} "${raw}": unsafe path segment`);
  }
  return cleaned;
}

function normalizePatternList(
  entries: readonly string[],
  label: string,
  requireNonEmpty: boolean
): readonly string[] {
  if (!Array.isArray(entries)) throw new Error(`Invalid ${label}: expected array`);
  const normalized = [...new Set(entries.map((entry) => normalizePattern(entry, label)))].sort();
  if (requireNonEmpty && normalized.length === 0) {
    throw new Error(`Invalid ${label}: must contain at least one entry`);
  }
  return Object.freeze(normalized);
}

function normalizeChangedPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/u, '');
  if (!cleaned || cleaned.startsWith('/') || /\0|\s/u.test(cleaned)) return null;
  const segments = cleaned.split('/');
  if (segments.some((segment) => segment === '' || segment === '..')) return null;
  return cleaned;
}

function canonicalPayload(payload: Omit<FactoryDeliveryEnvelope, 'envelope_sha256'>) {
  return {
    version: payload.version,
    mission_id: payload.mission_id,
    ...(payload.tenant_slug !== undefined ? { tenant_slug: payload.tenant_slug } : {}),
    authority_kind: payload.authority_kind,
    ...(payload.mandate_id !== undefined ? { mandate_id: payload.mandate_id } : {}),
    ...(payload.alignment_approval_ref !== undefined
      ? { alignment_approval_ref: payload.alignment_approval_ref }
      : {}),
    development_branch: payload.development_branch,
    scope_in: [...payload.scope_in].sort(),
    scope_out: [...payload.scope_out].sort(),
    allowed_paths: [...payload.allowed_paths].sort(),
    max_ci_repair_attempts: payload.max_ci_repair_attempts,
    merge_mode: payload.merge_mode,
    issued_at: payload.issued_at,
  };
}

export function computeFactoryEnvelopeHash(
  payload: Omit<FactoryDeliveryEnvelope, 'envelope_sha256'>
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload(payload)), 'utf8')
    .digest('hex');
}

export function createFactoryDeliveryEnvelope(
  input: FactoryDeliveryEnvelopeInput
): FactoryDeliveryEnvelope {
  const missionId = typeof input.mission_id === 'string' ? input.mission_id.trim() : '';
  if (!missionId || /\s/u.test(missionId)) {
    throw new Error('Invalid factory envelope mission_id');
  }
  let tenantSlug: string | undefined;
  if (input.tenant_slug !== undefined) {
    if (!isValidTenantSlug(input.tenant_slug)) {
      throw new Error(`Invalid factory envelope tenant_slug: ${String(input.tenant_slug)}`);
    }
    tenantSlug = input.tenant_slug;
  }

  let mandateId: string | undefined;
  let alignmentApprovalRef: string | undefined;
  if (input.authority_kind === 'standing_mandate') {
    const trimmed = typeof input.mandate_id === 'string' ? input.mandate_id.trim() : '';
    if (!trimmed) throw new Error('standing_mandate envelope requires mandate_id');
    mandateId = trimmed;
  } else if (input.authority_kind === 'alignment_brief') {
    const trimmed =
      typeof input.alignment_approval_ref === 'string' ? input.alignment_approval_ref.trim() : '';
    if (!trimmed) throw new Error('alignment_brief envelope requires alignment_approval_ref');
    alignmentApprovalRef = trimmed;
  } else {
    throw new Error(`Invalid factory envelope authority_kind: ${String(input.authority_kind)}`);
  }

  const developmentBranch = resolveMissionDevelopmentBranch(input.development_branch);
  if (!MERGE_MODES.has(input.merge_mode)) {
    throw new Error(`Invalid factory envelope merge_mode: ${String(input.merge_mode)}`);
  }

  const maxRepairs = input.max_ci_repair_attempts ?? 3;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) {
    throw new Error('max_ci_repair_attempts must be an integer between 0 and 3');
  }

  const issuedAt = input.issued_at ?? new Date().toISOString();
  if (typeof issuedAt !== 'string' || !issuedAt.trim() || Number.isNaN(Date.parse(issuedAt))) {
    throw new Error('Invalid factory envelope issued_at timestamp');
  }

  const unsigned: Omit<FactoryDeliveryEnvelope, 'envelope_sha256'> = {
    version: 1,
    mission_id: missionId,
    ...(tenantSlug !== undefined ? { tenant_slug: tenantSlug } : {}),
    authority_kind: input.authority_kind,
    ...(mandateId !== undefined ? { mandate_id: mandateId } : {}),
    ...(alignmentApprovalRef !== undefined ? { alignment_approval_ref: alignmentApprovalRef } : {}),
    development_branch: developmentBranch,
    scope_in: normalizePatternList(input.scope_in, 'scope_in', true),
    scope_out: normalizePatternList(input.scope_out ?? [], 'scope_out', false),
    allowed_paths: normalizePatternList(input.allowed_paths, 'allowed_paths', true),
    max_ci_repair_attempts: maxRepairs,
    merge_mode: input.merge_mode,
    issued_at: issuedAt,
  };

  return Object.freeze({
    ...unsigned,
    envelope_sha256: computeFactoryEnvelopeHash(unsigned),
  });
}

export function verifyFactoryEnvelopeIntegrity(envelope: FactoryDeliveryEnvelope): boolean {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.version !== 1) return false;
  if (typeof envelope.envelope_sha256 !== 'string' || !SHA256_RE.test(envelope.envelope_sha256)) {
    return false;
  }
  if (
    !Array.isArray(envelope.scope_in) ||
    !Array.isArray(envelope.scope_out) ||
    !Array.isArray(envelope.allowed_paths)
  ) {
    return false;
  }
  try {
    const reconstructed = createFactoryDeliveryEnvelope({
      mission_id: envelope.mission_id,
      tenant_slug: envelope.tenant_slug,
      authority_kind: envelope.authority_kind,
      mandate_id: envelope.mandate_id,
      alignment_approval_ref: envelope.alignment_approval_ref,
      development_branch: envelope.development_branch,
      scope_in: [...envelope.scope_in],
      scope_out: [...envelope.scope_out],
      allowed_paths: [...envelope.allowed_paths],
      max_ci_repair_attempts: envelope.max_ci_repair_attempts,
      merge_mode: envelope.merge_mode,
      issued_at: envelope.issued_at,
    });
    const sortedMatches =
      JSON.stringify(reconstructed.scope_in) === JSON.stringify(envelope.scope_in) &&
      JSON.stringify(reconstructed.scope_out) === JSON.stringify(envelope.scope_out) &&
      JSON.stringify(reconstructed.allowed_paths) === JSON.stringify(envelope.allowed_paths);
    return sortedMatches && reconstructed.envelope_sha256 === envelope.envelope_sha256;
  } catch {
    return false;
  }
}

export function createFactoryEnvelopeFromMandateBrief(input: {
  mission_id: string;
  tenant_slug?: string;
  brief: MandateBriefInput;
  development_branch: string;
  merge_mode?: FactoryMergeMode;
  max_ci_repair_attempts?: number;
  catalog?: MandateCatalog;
  now?: Date;
}):
  | { ok: true; envelope: FactoryDeliveryEnvelope; mandate_id: string }
  | { ok: false; reasons: string[] } {
  const catalog = input.catalog ?? loadMandateCatalog({ tenantOverlays: false });
  const evaluation = evaluateBriefAgainstMandates(input.brief, { catalog, now: input.now });
  if (!evaluation.covered || !evaluation.mandate_id) {
    return {
      ok: false,
      reasons: evaluation.reasons.length
        ? evaluation.reasons
        : ['brief not covered by any mandate'],
    };
  }
  const mandate = catalog.mandates.find((entry) => entry.id === evaluation.mandate_id);
  if (!mandate) {
    return { ok: false, reasons: [`matched mandate '${evaluation.mandate_id}' not found`] };
  }
  if (mandate.authority && mandate.authority.status !== 'active') {
    return { ok: false, reasons: [`mandate '${mandate.id}' authority is not active`] };
  }
  if (
    mandate.authority &&
    input.tenant_slug &&
    mandate.authority.tenant_slug !== input.tenant_slug
  ) {
    return {
      ok: false,
      reasons: [`mandate '${mandate.id}' authority does not match tenant '${input.tenant_slug}'`],
    };
  }

  const scopeIn = (input.brief.scope?.in ?? []).filter((entry) => entry.trim().length > 0);
  const envelope = createFactoryDeliveryEnvelope({
    mission_id: input.mission_id,
    tenant_slug: input.tenant_slug,
    authority_kind: 'standing_mandate',
    mandate_id: mandate.id,
    development_branch: input.development_branch,
    scope_in: scopeIn.length > 0 ? scopeIn : [...mandate.allowed_path_globs],
    scope_out: input.brief.scope?.out ?? [],
    allowed_paths: [...mandate.allowed_path_globs],
    max_ci_repair_attempts: input.max_ci_repair_attempts,
    merge_mode: input.merge_mode ?? 'veto_window',
    issued_at: (input.now ?? new Date()).toISOString(),
  });
  return { ok: true, envelope, mandate_id: mandate.id };
}

export interface AlignedBriefFactoryDeliveryConfig {
  enabled?: boolean;
  branch?: string;
  mergeMode?: FactoryMergeMode;
  maxCiRepairAttempts?: number;
  allowedPaths?: string[];
}

export interface AlignedBriefEnvelopeInput {
  mission_id: string;
  tenant_slug?: string;
  alignment_approval_ref: string;
  brief: {
    scope?: { in?: string[]; out?: string[] };
    factoryDelivery?: AlignedBriefFactoryDeliveryConfig;
  };
  development_branch?: string;
  now?: Date;
}

/** Build an immutable delivery envelope bound to an approved 1-shot alignment brief. */
export function createFactoryEnvelopeFromAlignedBrief(
  input: AlignedBriefEnvelopeInput
): { ok: true; envelope: FactoryDeliveryEnvelope } | { ok: false; reasons: string[] } {
  const config = input.brief.factoryDelivery;
  if (config?.enabled !== true) {
    return { ok: false, reasons: ['factoryDelivery is not enabled on the aligned brief'] };
  }
  const approvalRef =
    typeof input.alignment_approval_ref === 'string' ? input.alignment_approval_ref.trim() : '';
  if (!approvalRef) {
    return {
      ok: false,
      reasons: ['alignment_approval_ref is required for alignment_brief envelope'],
    };
  }
  const branchCandidate = config.branch ?? input.development_branch;
  if (typeof branchCandidate !== 'string' || !branchCandidate.trim()) {
    return {
      ok: false,
      reasons: ['factoryDelivery.branch is required for aligned brief envelope'],
    };
  }
  let developmentBranch: string;
  try {
    developmentBranch = resolveMissionDevelopmentBranch(branchCandidate);
  } catch (error) {
    return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }

  const rawAllowed = config.allowedPaths;
  if (!Array.isArray(rawAllowed) || rawAllowed.length === 0) {
    return {
      ok: false,
      reasons: ['factoryDelivery.allowedPaths must contain at least one path or glob'],
    };
  }

  const scopeIn = (input.brief.scope?.in ?? []).filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
  const scopeOut = (input.brief.scope?.out ?? []).filter(
    (entry) => typeof entry === 'string' && entry.trim().length > 0
  );
  const mergeMode: FactoryMergeMode = config.mergeMode ?? 'veto_window';

  try {
    const envelope = createFactoryDeliveryEnvelope({
      mission_id: input.mission_id,
      tenant_slug: input.tenant_slug,
      authority_kind: 'alignment_brief',
      alignment_approval_ref: approvalRef,
      development_branch: developmentBranch,
      scope_in: scopeIn.length > 0 ? scopeIn : [...rawAllowed],
      scope_out: scopeOut,
      allowed_paths: [...rawAllowed],
      max_ci_repair_attempts: config.maxCiRepairAttempts,
      merge_mode: mergeMode,
      issued_at: (input.now ?? new Date()).toISOString(),
    });
    return { ok: true, envelope };
  } catch (error) {
    return { ok: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

export function evaluateDiffAgainstFactoryEnvelope(
  input: FactoryEnvelopeDiffCheckInput
): FactoryEnvelopeDiffCheckResult {
  const { envelope } = input;
  if (!verifyFactoryEnvelopeIntegrity(envelope)) {
    return {
      ok: false,
      violations: [
        {
          code: 'integrity_mismatch',
          detail: 'Factory delivery envelope failed SHA-256 or canonical shape verification',
          paths: [],
        },
      ],
      recommended_merge_mode: 'human_only',
      high_risk_matches: [],
      scope_out_matches: [],
      outside_allowed_paths: [],
    };
  }

  const normalizedPaths: string[] = [];
  const invalidPaths: string[] = [];
  for (const raw of input.changed_paths) {
    const normalized = normalizeChangedPath(raw);
    if (!normalized) invalidPaths.push(String(raw));
    else normalizedPaths.push(normalized);
  }
  const uniquePaths = [...new Set(normalizedPaths)].sort();

  const violations: FactoryEnvelopeDiffViolation[] = [];
  if (uniquePaths.length === 0 && invalidPaths.length === 0) {
    violations.push({
      code: 'empty_diff',
      detail: 'Changed path list is empty',
      paths: [],
    });
    return {
      ok: false,
      violations,
      recommended_merge_mode: 'human_only',
      high_risk_matches: [],
      scope_out_matches: [],
      outside_allowed_paths: [],
    };
  }

  let policy: AutonomousOpsPolicy;
  try {
    policy = input.policy ?? getAutonomousOpsPolicy();
  } catch (error) {
    violations.push({
      code: 'high_risk_path',
      detail: `Autonomous ops policy unavailable (${error instanceof Error ? error.message : String(error)}); failing closed`,
      paths: uniquePaths,
    });
    return {
      ok: false,
      violations,
      recommended_merge_mode: 'human_only',
      high_risk_matches: uniquePaths,
      scope_out_matches: [],
      outside_allowed_paths: [],
    };
  }

  const highRiskSet = new Set(matchHighRiskPaths(uniquePaths, policy.high_risk_paths ?? []));
  for (const candidate of uniquePaths) {
    if (candidate.split('/').includes('.git')) highRiskSet.add(candidate);
  }
  for (const bad of invalidPaths) highRiskSet.add(bad);
  const highRiskMatches = [...highRiskSet].sort();
  if (highRiskMatches.length > 0) {
    violations.push({
      code: 'high_risk_path',
      detail: `Diff touches high-risk paths: ${highRiskMatches.join(', ')}`,
      paths: highRiskMatches,
    });
  }

  const scopeOutMatches =
    envelope.scope_out.length > 0
      ? [...new Set(matchHighRiskPaths(uniquePaths, [...envelope.scope_out]))].sort()
      : [];
  if (scopeOutMatches.length > 0) {
    violations.push({
      code: 'scope_out',
      detail: `Diff touches scope_out paths: ${scopeOutMatches.join(', ')}`,
      paths: scopeOutMatches,
    });
  }

  const allowedSet = new Set(matchHighRiskPaths(uniquePaths, [...envelope.allowed_paths]));
  const outsideAllowed = [...uniquePaths.filter((entry) => !allowedSet.has(entry)), ...invalidPaths]
    .filter((entry, idx, arr) => arr.indexOf(entry) === idx)
    .sort();
  if (outsideAllowed.length > 0) {
    violations.push({
      code: 'outside_allowed_paths',
      detail: `Diff touches paths outside allowed_paths: ${outsideAllowed.join(', ')}`,
      paths: outsideAllowed,
    });
  }

  const ok = violations.length === 0;
  let recommendedMergeMode: FactoryMergeMode;
  if (!ok || envelope.merge_mode === 'human_only') {
    recommendedMergeMode = 'human_only';
  } else if (envelope.merge_mode === 'auto_low_risk') {
    const lowRiskMatches = matchHighRiskPaths(uniquePaths, [...LOW_RISK_GLOBS]);
    recommendedMergeMode =
      lowRiskMatches.length === uniquePaths.length ? 'auto_low_risk' : 'veto_window';
  } else {
    recommendedMergeMode = 'veto_window';
  }

  return {
    ok,
    violations,
    recommended_merge_mode: recommendedMergeMode,
    high_risk_matches: highRiskMatches,
    scope_out_matches: scopeOutMatches,
    outside_allowed_paths: outsideAllowed,
  };
}
