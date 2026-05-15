#!/usr/bin/env node
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

export type ProductionEvidenceStatus = 'pending_external_evidence' | 'verified';

export interface ProductionEvidenceItem {
  id: string;
  gate: string;
  required_evidence: string;
  status: ProductionEvidenceStatus;
  owner: string;
  template_ref: string;
  acceptance_criteria: string[];
  verification_artifact: string;
  reviewed_at: string | null;
  reviewer: string | null;
  ref_requirements: ProductionEvidenceRefRequirement[];
  evidence_refs: string[];
}

export interface ProductionEvidenceRefRequirement {
  id: string;
  description: string;
  accepted_ref_patterns: string[];
}

export interface ProductionEvidenceRegister {
  version: string;
  last_updated: string;
  release_decision: ProductionEvidenceStatus;
  items: ProductionEvidenceItem[];
}

export interface ProductionEvidenceSummary {
  ok: boolean;
  complete: boolean;
  total: number;
  verified: number;
  pending: ProductionEvidenceItem[];
  invalid: string[];
  release_decision: string;
}

const DEFAULT_REGISTER_PATH = 'knowledge/public/governance/production-evidence-register.json';
const SUPPORTED_REF_SCHEMES = ['http:', 'https:'];
export const REQUIRED_PRODUCTION_EVIDENCE_IDS = ['EV-30DAY-OPS', 'EV-EXT-CONTRIB', 'EV-FDE-DEPLOY'] as const;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINIMUM_EVIDENCE_REF_COUNTS: Record<(typeof REQUIRED_PRODUCTION_EVIDENCE_IDS)[number], number> = {
  'EV-30DAY-OPS': 3,
  'EV-EXT-CONTRIB': 3,
  'EV-FDE-DEPLOY': 4,
};
const REQUIRED_TEMPLATE_REFS: Record<(typeof REQUIRED_PRODUCTION_EVIDENCE_IDS)[number], string> = {
  'EV-30DAY-OPS': 'docs/operator/templates/production-evidence-30day-ops.md',
  'EV-EXT-CONTRIB': 'docs/operator/templates/production-evidence-external-contribution.md',
  'EV-FDE-DEPLOY': 'docs/operator/templates/production-evidence-fde-deployment.md',
};
const REQUIRED_REF_REQUIREMENT_IDS: Record<(typeof REQUIRED_PRODUCTION_EVIDENCE_IDS)[number], readonly string[]> = {
  'EV-30DAY-OPS': ['run_summary', 'trace_bundle', 'incident_summary'],
  'EV-EXT-CONTRIB': ['issue_url', 'pr_url', 'review_record'],
  'EV-FDE-DEPLOY': ['deployment_summary', 'customer_overlay', 'runtime_artifact', 'no_fork_statement'],
};
const REQUIRED_REF_REQUIREMENT_PATTERNS: Record<string, readonly string[]> = {
  run_summary: ['docs/operator/', 'https://'],
  trace_bundle: ['active/shared/logs/traces/', 'active/shared/tmp/', 'https://'],
  incident_summary: ['docs/operator/', 'https://'],
  issue_url: ['/issues/'],
  pr_url: ['/pull/'],
  review_record: ['docs/operator/templates/production-evidence-external-contribution.md', 'https://github.com/'],
  deployment_summary: ['docs/operator/', 'https://'],
  customer_overlay: ['customer/', 'docs/operator/', 'https://'],
  runtime_artifact: ['active/shared/logs/traces/', 'active/shared/tmp/', 'https://'],
  no_fork_statement: ['docs/operator/', 'migration/', 'https://'],
};

function parseRegister(raw: string, source: string): ProductionEvidenceRegister {
  try {
    return JSON.parse(raw) as ProductionEvidenceRegister;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid production evidence register JSON at ${source}: ${message}`);
  }
}

export function loadProductionEvidenceRegister(registerPath = DEFAULT_REGISTER_PATH): ProductionEvidenceRegister {
  const resolved = pathResolver.rootResolve(registerPath);
  const raw = safeReadFile(resolved, { encoding: 'utf8' }) as string;
  return parseRegister(raw, registerPath);
}

function isSupportedUrlRef(ref: string): boolean {
  try {
    const url = new URL(ref);
    return SUPPORTED_REF_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

function isExistingLocalEvidenceRef(ref: string): boolean {
  if (!ref || ref.startsWith('/') || ref.includes('\0')) return false;
  if (ref.includes('..')) return false;
  return safeExistsSync(pathResolver.rootResolve(ref));
}

export function isValidEvidenceRef(ref: string): boolean {
  const normalized = ref.trim();
  return isSupportedUrlRef(normalized) || isExistingLocalEvidenceRef(normalized);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidPastOrTodayIsoDate(value: string): boolean {
  return isValidIsoCalendarDate(value) && value <= todayIsoDate();
}

function matchesRefRequirement(ref: string, requirement: ProductionEvidenceRefRequirement): boolean {
  return requirement.accepted_ref_patterns.some((pattern) => ref.includes(pattern));
}

function findDistinctRequirementIssues(
  evidenceRefs: string[],
  requirements: ProductionEvidenceRefRequirement[],
  itemId: string
): string[] {
  const invalid: string[] = [];
  const usedRefIndexes = new Set<number>();

  for (const requirement of requirements) {
    const unusedMatchIndex = evidenceRefs.findIndex(
      (ref, index) => !usedRefIndexes.has(index) && matchesRefRequirement(ref, requirement)
    );
    if (unusedMatchIndex >= 0) {
      usedRefIndexes.add(unusedMatchIndex);
      continue;
    }

    if (evidenceRefs.some((ref) => matchesRefRequirement(ref, requirement))) {
      invalid.push(`${itemId}.evidence_refs missing distinct required category: ${requirement.id}`);
    } else {
      invalid.push(`${itemId}.evidence_refs missing required category: ${requirement.id}`);
    }
  }

  return invalid;
}

function findDuplicateEvidenceRefs(evidenceRefs: string[], itemId: string): string[] {
  const invalid: string[] = [];
  const seenRefs = new Set<string>();

  for (const ref of evidenceRefs) {
    const normalized = ref.trim();
    if (seenRefs.has(normalized)) {
      invalid.push(`${itemId}.evidence_refs contains duplicate artifact: ${normalized}`);
    } else {
      seenRefs.add(normalized);
    }
  }

  return invalid;
}

function findMissingEvidenceRefs(evidenceRefs: string[], itemId: string): string[] {
  const invalid: string[] = [];

  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string') continue;
    const normalized = ref.trim();
    if (isSupportedUrlRef(normalized)) continue;
    if (!isExistingLocalEvidenceRef(normalized)) {
      invalid.push(`${itemId}.evidence_refs missing existing local artifact: ${normalized}`);
    }
  }

  return invalid;
}

function patternsEqual(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((pattern, index) => pattern === expected[index]);
}

export function checkProductionEvidenceRegister(
  register: ProductionEvidenceRegister,
  options: { requireComplete?: boolean } = {}
): ProductionEvidenceSummary {
  const invalid: string[] = [];
  const items = Array.isArray(register.items) ? register.items : [];

  if (!register.version || !register.version.trim()) {
    invalid.push('register.version is required');
  } else if (!SEMVER_RE.test(register.version)) {
    invalid.push('register.version must be MAJOR.MINOR.PATCH');
  }
  if (!register.last_updated || !register.last_updated.trim()) {
    invalid.push('register.last_updated is required');
  } else if (!isValidPastOrTodayIsoDate(register.last_updated)) {
    invalid.push('register.last_updated must be an ISO date that is not in the future');
  }
  if (!['pending_external_evidence', 'verified'].includes(register.release_decision)) {
    invalid.push('register.release_decision must be pending_external_evidence or verified');
  }
  if (!Array.isArray(register.items)) invalid.push('register.items must be an array');

  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id || !item.id.trim()) invalid.push('item.id is required');
    if (item.id && seen.has(item.id)) invalid.push(`duplicate item id: ${item.id}`);
    if (item.id) seen.add(item.id);
    if (!item.gate || !item.gate.trim()) invalid.push(`${item.id || 'item'}.gate is required`);
    if (!item.required_evidence || !item.required_evidence.trim()) {
      invalid.push(`${item.id || 'item'}.required_evidence is required`);
    }
    if (!['pending_external_evidence', 'verified'].includes(item.status)) {
      invalid.push(`${item.id || 'item'}.status must be pending_external_evidence or verified`);
    }
    if (!item.owner || !item.owner.trim()) invalid.push(`${item.id || 'item'}.owner is required`);
    if (!item.template_ref || !item.template_ref.trim()) {
      invalid.push(`${item.id || 'item'}.template_ref is required`);
    } else if (!isExistingLocalEvidenceRef(item.template_ref)) {
      invalid.push(`${item.id || 'item'}.template_ref must point to an existing repo-local template`);
    } else {
      const expectedTemplateRef = REQUIRED_TEMPLATE_REFS[item.id as keyof typeof REQUIRED_TEMPLATE_REFS];
      if (expectedTemplateRef && item.template_ref !== expectedTemplateRef) {
        invalid.push(`${item.id || 'item'}.template_ref must be ${expectedTemplateRef}`);
      }
    }
    if (!Array.isArray(item.acceptance_criteria) || item.acceptance_criteria.length === 0) {
      invalid.push(`${item.id || 'item'}.acceptance_criteria must include at least one criterion`);
    } else {
      for (const criterion of item.acceptance_criteria) {
        if (typeof criterion !== 'string' || !criterion.trim()) {
          invalid.push(`${item.id || 'item'}.acceptance_criteria contains an empty criterion`);
        }
      }
    }
    if (!item.verification_artifact || !item.verification_artifact.trim()) {
      invalid.push(`${item.id || 'item'}.verification_artifact is required`);
    }
    if (!Array.isArray(item.ref_requirements) || item.ref_requirements.length === 0) {
      invalid.push(`${item.id || 'item'}.ref_requirements must include at least one requirement`);
    } else {
      const requirementIds = new Set<string>();
      for (const requirement of item.ref_requirements) {
        if (!requirement.id || !requirement.id.trim()) {
          invalid.push(`${item.id || 'item'}.ref_requirements.id is required`);
        }
        if (requirement.id && requirementIds.has(requirement.id)) {
          invalid.push(`${item.id || 'item'}.ref_requirements contains duplicate id: ${requirement.id}`);
        }
        if (requirement.id) requirementIds.add(requirement.id);
        if (!requirement.description || !requirement.description.trim()) {
          invalid.push(`${item.id || 'item'}.${requirement.id || 'requirement'}.description is required`);
        }
        if (!Array.isArray(requirement.accepted_ref_patterns) || requirement.accepted_ref_patterns.length === 0) {
          invalid.push(`${item.id || 'item'}.${requirement.id || 'requirement'}.accepted_ref_patterns must include at least one pattern`);
        } else {
          for (const pattern of requirement.accepted_ref_patterns) {
            if (typeof pattern !== 'string' || !pattern.trim()) {
              invalid.push(
                `${item.id || 'item'}.${requirement.id || 'requirement'}.accepted_ref_patterns contains an empty pattern`
              );
            }
          }
          const expectedPatterns = REQUIRED_REF_REQUIREMENT_PATTERNS[requirement.id];
          if (expectedPatterns && !patternsEqual(requirement.accepted_ref_patterns, expectedPatterns)) {
            invalid.push(
              `${item.id || 'item'}.${requirement.id}.accepted_ref_patterns must be ${expectedPatterns.join(', ')}`
            );
          }
        }
      }
      const expectedRequirementIds = REQUIRED_REF_REQUIREMENT_IDS[item.id as keyof typeof REQUIRED_REF_REQUIREMENT_IDS];
      if (expectedRequirementIds) {
        for (const expectedId of expectedRequirementIds) {
          if (!requirementIds.has(expectedId)) {
            invalid.push(`${item.id}.ref_requirements missing required category id: ${expectedId}`);
          }
        }
        for (const requirementId of requirementIds) {
          if (!expectedRequirementIds.includes(requirementId)) {
            invalid.push(`${item.id}.ref_requirements contains unknown category id: ${requirementId}`);
          }
        }
      }
    }
    if (!Array.isArray(item.evidence_refs)) invalid.push(`${item.id || 'item'}.evidence_refs must be an array`);
    if (item.status === 'verified') {
      if (!item.reviewed_at) invalid.push(`${item.id}.reviewed_at is required when verified`);
      else if (!isValidPastOrTodayIsoDate(item.reviewed_at)) {
        invalid.push(`${item.id}.reviewed_at must be an ISO date that is not in the future`);
      }
      if (!item.reviewer || !item.reviewer.trim()) invalid.push(`${item.id}.reviewer is required when verified`);
      if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length === 0) {
        invalid.push(`${item.id}.evidence_refs must include at least one artifact when verified`);
      } else {
        const minimumRefCount = MINIMUM_EVIDENCE_REF_COUNTS[item.id as keyof typeof MINIMUM_EVIDENCE_REF_COUNTS];
        if (minimumRefCount && item.evidence_refs.length < minimumRefCount) {
          invalid.push(`${item.id}.evidence_refs must include at least ${minimumRefCount} artifacts when verified`);
        }
        for (const ref of item.evidence_refs) {
          if (typeof ref !== 'string' || !isValidEvidenceRef(ref)) {
            invalid.push(`${item.id}.evidence_refs contains unsupported or missing artifact: ${String(ref)}`);
          } else if (ref !== ref.trim()) {
            invalid.push(`${item.id}.evidence_refs contains artifact with surrounding whitespace: ${ref}`);
          }
        }
        const stringEvidenceRefs = item.evidence_refs.filter((ref): ref is string => typeof ref === 'string');
        invalid.push(...findDuplicateEvidenceRefs(stringEvidenceRefs, item.id));
        invalid.push(...findMissingEvidenceRefs(stringEvidenceRefs, item.id));
        invalid.push(
          ...findDistinctRequirementIssues(
            stringEvidenceRefs,
            item.ref_requirements || [],
            item.id
          )
        );
      }
    }
  }
  for (const expectedId of REQUIRED_PRODUCTION_EVIDENCE_IDS) {
    if (!seen.has(expectedId)) invalid.push(`register.items missing required evidence id: ${expectedId}`);
  }
  for (const id of seen) {
    if (!(REQUIRED_PRODUCTION_EVIDENCE_IDS as readonly string[]).includes(id)) {
      invalid.push(`register.items contains unknown evidence id: ${id}`);
    }
  }

  const pending = items.filter((item) => item.status !== 'verified');
  if (items.length > 0 && pending.length > 0 && register.release_decision === 'verified') {
    invalid.push('register.release_decision cannot be verified while evidence items are pending');
  }
  if (items.length > 0 && pending.length === 0 && register.release_decision !== 'verified') {
    invalid.push('register.release_decision must be verified when all evidence items are verified');
  }
  const complete = invalid.length === 0 && items.length > 0 && pending.length === 0 && register.release_decision === 'verified';
  const ok = invalid.length === 0 && (!options.requireComplete || complete);

  return {
    ok,
    complete,
    total: items.length,
    verified: items.length - pending.length,
    pending,
    invalid,
    release_decision: register.release_decision,
  };
}

function formatSummary(summary: ProductionEvidenceSummary): string {
  const lines = [
    `production evidence: ${summary.verified}/${summary.total} verified; release_decision=${summary.release_decision}`,
  ];
  if (summary.invalid.length > 0) {
    lines.push('invalid register entries:');
    for (const issue of summary.invalid) lines.push(`- ${issue}`);
  }
  if (summary.pending.length > 0) {
    lines.push('pending external evidence:');
    for (const item of summary.pending) lines.push(`- ${item.id}: ${item.gate}`);
  }
  if (summary.complete) lines.push('all production evidence is verified');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let json = false;
  let requireComplete = false;
  let registerPath = DEFAULT_REGISTER_PATH;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--require-complete') requireComplete = true;
    else if (arg === '--register') registerPath = args[++i];
  }

  const register = loadProductionEvidenceRegister(registerPath);
  const summary = checkProductionEvidenceRegister(register, { requireComplete });
  const output = json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary);

  if (summary.ok) process.stdout.write(output);
  else process.stderr.write(output);
  process.exit(summary.ok ? 0 : 1);
}

const isDirect = process.argv[1] && /check_production_evidence\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
