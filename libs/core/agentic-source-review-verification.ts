import { createHash } from 'node:crypto';

import AjvModule, { type Ajv as AjvInstance } from 'ajv';

import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import type { SourceAnalysisIr } from './source-analysis.js';

const VERIFICATION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/agentic-source-review-verification.schema.json'
);
const AjvCtor = AjvModule as unknown as new (options: { allErrors: boolean }) => AjvInstance;
const validateVerificationSchema = compileSchemaFromPath(
  new AjvCtor({ allErrors: true }),
  VERIFICATION_SCHEMA_PATH
);

export const REVIEW_TRACKS = ['access_control', 'data_flow', 'dependency_supply_chain'] as const;
export type ReviewTrack = (typeof REVIEW_TRACKS)[number];

export interface ReviewCoverageLedger {
  kind: 'agentic-source-review-coverage';
  version: '1.0.0';
  source_root: string;
  source_snapshot_sha256: string;
  source_files_observed: number;
  source_files_total: number;
  source_scan_truncated: boolean;
  entry_points_total: number;
  entry_points_selected: number;
  entry_points_uncovered: number;
  tracks: Array<{
    id: ReviewTrack;
    entry_points_total: number;
    entry_points_selected: number;
    entry_points_uncovered: number;
  }>;
  follow_up_required: boolean;
  limitations: string[];
}

export interface AgenticSourceReviewCandidate {
  kind: 'agentic-source-review-candidate';
  version: '1.0.0';
  candidate_id: string;
  fingerprint: string;
  title: string;
  track: ReviewTrack;
  severity_hint: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  entry_point_id: string | null;
  source_refs: string[];
  hypothesis: string;
  evidence: string[];
  trust: 'untrusted';
  verification_status: 'unverified';
}

export interface CandidateVerification {
  candidate_id: string;
  fingerprint: string;
  decision: 'new' | 'duplicate' | 'needs_review' | 'rejected';
  verification_status: 'evidence_ready' | 'unverified' | 'blocked';
  reasons: string[];
  checks: {
    schema_valid: boolean;
    source_refs_known: boolean;
    entry_point_known: boolean;
    evidence_present: boolean;
    executable_witness: false;
  };
  candidate: AgenticSourceReviewCandidate | null;
}

export interface AgenticSourceReviewVerificationReport {
  kind: 'agentic-source-review-verification';
  version: '1.0.0';
  source_root: string;
  coverage: ReviewCoverageLedger;
  policy: {
    execution: 'disabled';
    malformed_candidate: 'hold_for_review';
    duplicate_decision: 'hold_for_review';
    automatic_remediation: false;
    human_validation_required: true;
  };
  findings: CandidateVerification[];
  summary: {
    total: number;
    new_candidates: number;
    duplicates: number;
    needs_review: number;
    rejected: number;
  };
  reverification: {
    status: 'not_started';
    required_for: string[];
    next_actions: string[];
    regression_test_promotion: {
      status: 'approval_required';
      artifact_kind: 'source-test-scenarios';
      candidate_ids: string[];
    };
  };
  limitations: string[];
}

export interface CompileVerificationOptions {
  analysis: SourceAnalysisIr;
  entryPoints: Array<{ id: string; review_tracks: string[] }>;
  candidates?: unknown;
  knownFindingFingerprints?: string[];
  scope?: {
    tenant_slug: string;
    project_id: string;
    mission_id: string;
  };
  knownFindingScope?: {
    tenant_slug: string;
    project_id: string;
    mission_id: string;
  };
}

function stableFingerprint(input: unknown): string {
  const serialized =
    input && typeof input === 'object'
      ? JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort())
      : JSON.stringify(input);
  return createHash('sha256')
    .update(serialized || '')
    .digest('hex');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(asString).filter(Boolean))].sort();
}

function extractCandidateList(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [input];
  const record = input as Record<string, unknown>;
  for (const key of ['candidates', 'findings', 'hypotheses', 'items', 'results']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [input];
}

function assertDeduplicationScope(options: CompileVerificationOptions): void {
  const known = options.knownFindingFingerprints ?? [];
  if (known.length === 0) return;
  const current = options.scope;
  const knownScope = options.knownFindingScope;
  if (!current || !knownScope) {
    throw new Error(
      '[AGENTIC_SOURCE_REVIEW_DEDUP_SCOPE_REQUIRED] known finding fingerprints require current and source tenant/project/mission scope'
    );
  }
  if (
    current.tenant_slug !== knownScope.tenant_slug ||
    current.project_id !== knownScope.project_id ||
    current.mission_id !== knownScope.mission_id
  ) {
    throw new Error(
      '[AGENTIC_SOURCE_REVIEW_DEDUP_SCOPE_MISMATCH] known finding fingerprints cannot cross tenant, project or mission scope'
    );
  }
}

function normalizeSourceRef(ref: string, sourceRoot: string): string {
  const normalized = ref.replaceAll('\\', '/').replace(/^\.\//u, '');
  const prefix = `${sourceRoot.replace(/\/$/u, '')}/`;
  const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return relative.replace(/:\d+(?::\d+)?$/u, '');
}

function allEntryPointCandidates(analysis: SourceAnalysisIr): number {
  if (analysis.routes.length > 0) return analysis.routes.length;
  return analysis.files
    .filter((file) => file.kind === 'source')
    .reduce((total, file) => total + file['exports'].length, 0);
}

function sourceSnapshotSha256(analysis: SourceAnalysisIr): string {
  return createHash('sha256')
    .update(
      analysis.files
        .map((file) => `${file.path}\0${file.sha256}`)
        .sort()
        .join('\n')
    )
    .digest('hex');
}

export function buildReviewCoverageLedger(
  analysis: SourceAnalysisIr,
  entryPoints: Array<{ id: string; review_tracks: string[] }>
): ReviewCoverageLedger {
  const entryPointsTotal = allEntryPointCandidates(analysis);
  const selectedIds = new Set(entryPoints.map((entryPoint) => entryPoint.id));
  const tracks = REVIEW_TRACKS.map((track) => {
    const selected = entryPoints.filter((entryPoint) => entryPoint.review_tracks.includes(track));
    const total = entryPointsTotal;
    return {
      id: track,
      entry_points_total: total,
      entry_points_selected: selected.length,
      entry_points_uncovered: Math.max(0, total - selected.length),
    };
  });
  const scan = analysis.scan ?? {
    max_files: analysis.file_count,
    files_observed: analysis.file_count,
    truncated: false,
  };
  const entryPointsUncovered = Math.max(0, entryPointsTotal - selectedIds.size);
  return {
    kind: 'agentic-source-review-coverage',
    version: '1.0.0',
    source_root: analysis.source_root,
    source_snapshot_sha256: sourceSnapshotSha256(analysis),
    source_files_observed: scan.files_observed,
    source_files_total: analysis.file_count,
    source_scan_truncated: scan.truncated,
    entry_points_total: entryPointsTotal,
    entry_points_selected: selectedIds.size,
    entry_points_uncovered: entryPointsUncovered,
    tracks,
    follow_up_required: scan.truncated || entryPointsUncovered > 0,
    limitations: [
      'Coverage records discovery and assignment, not semantic reachability or vulnerability absence.',
      'Entry-point partitions are static signals and require human confirmation before execution.',
      ...(scan.truncated ? [`Source scan was capped at ${scan.max_files} files.`] : []),
    ],
  };
}

function normalizeCandidate(
  raw: unknown,
  index: number,
  analysis: SourceAnalysisIr,
  entryPoints: Array<{ id: string; review_tracks: string[] }>
): CandidateVerification {
  const rawFingerprint = stableFingerprint(raw);
  const fallbackId = `INVALID-${rawFingerprint.slice(0, 12)}`;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const candidateId =
    asString(record.candidate_id) || `CANDIDATE-${String(index + 1).padStart(3, '0')}`;
  const title = asString(record.title) || asString(record.summary);
  const track = asString(record.track) as ReviewTrack;
  const severity = asString(
    record.severity_hint || record.severity
  ) as AgenticSourceReviewCandidate['severity_hint'];
  const entryPointId =
    record.entry_point_id === null ? null : asString(record.entry_point_id) || null;
  const sourceRefs = asStrings(record.source_refs || record.references || record.evidence_refs);
  const evidence = asStrings(record.evidence || record.reasoning || record.proof);
  const hypothesis = asString(record.hypothesis || record.description || record.reasoning);
  const errors: string[] = [];
  if (!title) errors.push('candidate title is missing');
  if (!REVIEW_TRACKS.includes(track)) errors.push('candidate track is missing or invalid');
  if (!['low', 'medium', 'high', 'critical', 'unknown'].includes(severity))
    errors.push('candidate severity_hint is missing or invalid');
  if (!hypothesis) errors.push('candidate hypothesis is missing');
  if (sourceRefs.length === 0) errors.push('candidate source_refs are missing');
  if (evidence.length === 0) errors.push('candidate evidence is missing');

  const knownFiles = new Set(analysis.files.map((file) => file.path));
  const normalizedRefs = sourceRefs.map((ref) => normalizeSourceRef(ref, analysis.source_root));
  const sourceRefsKnown =
    normalizedRefs.length > 0 && normalizedRefs.every((ref) => knownFiles.has(ref));
  if (!sourceRefsKnown) errors.push('candidate references an unknown source path');
  const entryPointKnown =
    entryPointId === null || entryPoints.some((entryPoint) => entryPoint.id === entryPointId);
  if (!entryPointKnown) errors.push('candidate references an unknown entry point');

  const fingerprint = stableFingerprint({
    track,
    title: title.toLowerCase(),
    entry_point_id: entryPointId,
    source_refs: normalizedRefs,
    hypothesis: hypothesis.toLowerCase(),
  });
  const schemaValid = errors.length === 0;
  const candidate = schemaValid
    ? {
        kind: 'agentic-source-review-candidate' as const,
        version: '1.0.0' as const,
        candidate_id: candidateId,
        fingerprint,
        title,
        track,
        severity_hint: severity,
        entry_point_id: entryPointId,
        source_refs: normalizedRefs,
        hypothesis,
        evidence,
        trust: 'untrusted' as const,
        verification_status: 'unverified' as const,
      }
    : null;
  return {
    candidate_id: candidate?.candidate_id || candidateId || fallbackId,
    fingerprint,
    decision: schemaValid ? 'new' : 'needs_review',
    verification_status: schemaValid ? 'evidence_ready' : 'blocked',
    reasons: schemaValid
      ? ['Static evidence contract is complete; human validation remains required.']
      : errors,
    checks: {
      schema_valid: schemaValid,
      source_refs_known: sourceRefsKnown,
      entry_point_known: entryPointKnown,
      evidence_present: evidence.length > 0,
      executable_witness: false,
    },
    candidate,
  };
}

export function compileAgenticSourceReviewVerification(
  options: CompileVerificationOptions
): AgenticSourceReviewVerificationReport {
  assertDeduplicationScope(options);
  const coverage = buildReviewCoverageLedger(options.analysis, options.entryPoints);
  const known = new Set(options.knownFindingFingerprints ?? []);
  const findings = extractCandidateList(options.candidates).map((raw, index) => {
    const finding = normalizeCandidate(raw, index, options.analysis, options.entryPoints);
    if (finding.decision === 'new' && known.has(finding.fingerprint)) {
      return {
        ...finding,
        decision: 'duplicate' as const,
        verification_status: 'unverified' as const,
        reasons: ['Fingerprint already exists; duplicate decisions remain held for human review.'],
      };
    }
    if (finding.decision === 'new') known.add(finding.fingerprint);
    return finding;
  });
  const summary = {
    total: findings.length,
    new_candidates: findings.filter((finding) => finding.decision === 'new').length,
    duplicates: findings.filter((finding) => finding.decision === 'duplicate').length,
    needs_review: findings.filter((finding) => finding.decision === 'needs_review').length,
    rejected: findings.filter((finding) => finding.decision === 'rejected').length,
  };
  const report: AgenticSourceReviewVerificationReport = {
    kind: 'agentic-source-review-verification',
    version: '1.0.0',
    source_root: options.analysis.source_root,
    coverage,
    policy: {
      execution: 'disabled',
      malformed_candidate: 'hold_for_review',
      duplicate_decision: 'hold_for_review',
      automatic_remediation: false,
      human_validation_required: true,
    },
    findings,
    summary,
    reverification: {
      status: 'not_started',
      required_for: findings
        .filter((finding) => finding.decision === 'new')
        .map((finding) => finding.candidate_id),
      next_actions: [
        'Human expert must reproduce or disprove each new candidate in an approved environment.',
        'After an approved fix, rerun this verification and promote a regression scenario.',
      ],
      regression_test_promotion: {
        status: 'approval_required',
        artifact_kind: 'source-test-scenarios',
        candidate_ids: findings
          .filter((finding) => finding.decision === 'new')
          .map((finding) => finding.candidate_id),
      },
    },
    limitations: [
      'This operation validates the evidence contract; it does not prove a vulnerability.',
      'No target code, PoC, exploit, patch, or external command is executed.',
      'Malformed or duplicate candidates fail closed into human review.',
    ],
  };
  validateAgenticSourceReviewVerification(report);
  return report;
}

export function validateAgenticSourceReviewVerification(
  report: AgenticSourceReviewVerificationReport
): void {
  if (!validateVerificationSchema(report)) {
    throw new Error(
      `[AGENTIC_SOURCE_REVIEW_VERIFICATION_SCHEMA] invalid report: ${JSON.stringify(validateVerificationSchema.errors)}`
    );
  }
}
