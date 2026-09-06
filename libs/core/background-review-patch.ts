/**
 * HA-01 explicitly approved pipeline-patch application.
 *
 * Background review may suggest a patch, but the fork never applies it. This
 * module is the narrow human-approved bridge: it accepts only an append-step
 * patch to a system pipeline or an append-only section to an explicitly
 * registered background-review skill, verifies the candidate provenance and
 * the caller's expected pre-image hash, keeps a governed backup, then writes.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { assertBackgroundReviewOperationAllowed } from './background-review-policy.js';
import {
  loadDistillCandidateRecord,
  updateDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import { readTextFile } from './foundation/text.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { applyConsolidationActions, type ConsolidationAction } from './memory-notebook.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  loadApprovalRequest,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';

const PIPELINE_REF_PATTERN = /^pipelines\/[A-Za-z0-9._/-]+\.json$/u;
const MANAGED_SKILL_REF_PATTERN =
  /^active\/shared\/runtime\/background-review\/skills\/[a-z0-9][a-z0-9._-]{0,63}\/SKILL\.md$/u;
const MEMORY_NOTEBOOK_REF_PATTERN =
  /^(?:knowledge\/(?:personal|confidential|public)\/missions\/[A-Za-z0-9._-]+|active\/missions\/(?:personal|confidential|public)\/[A-Za-z0-9._-]+|active\/shared\/runtime\/session\/[A-Za-z0-9._-]+|active\/personal)\/MEMORY\.md$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MANAGED_SKILL_PROVENANCE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/background-review-managed-skill-provenance.schema.json'
);

export interface BackgroundPipelineAppendStepPatch {
  operation: 'append_step';
  step: Record<string, unknown>;
}

export interface BackgroundSkillAppendSectionPatch {
  operation: 'append_section';
  section: string;
}

export interface BackgroundMemoryConsolidationPatch {
  operation: 'apply_consolidation';
  actions: ConsolidationAction[];
}

export type BackgroundReviewPatch =
  | BackgroundPipelineAppendStepPatch
  | BackgroundSkillAppendSectionPatch
  | BackgroundMemoryConsolidationPatch;

export interface ApplyBackgroundReviewPipelinePatchInput {
  candidateId: string;
  expectedSha256: string;
  approvedBy: string;
  approvalRef: string;
}

export interface ApplyBackgroundReviewPipelinePatchResult {
  candidate_id: string;
  target_ref: string;
  backup_ref: string;
  before_sha256: string;
  after_sha256: string;
  approved_by: string;
}

interface BackgroundReviewMetadata extends Record<string, unknown> {
  origin?: unknown;
  action?: unknown;
  target_ref?: unknown;
  patch?: unknown;
  provenance?: unknown;
}

export interface BackgroundReviewApprovalRequestInput {
  candidateId: string;
  expectedSha256: string;
  requestedBy?: string;
  missionId?: string;
  approvalChannel?: string;
  approvalThreadTs?: string;
}

export interface BackgroundReviewApprovalPreview {
  candidateId: string;
  action: 'pipeline_proposal' | 'skill_patch' | 'memory_consolidation';
  targetRef: string;
  expectedSha256: string;
  patch: BackgroundReviewPatch;
}

const BACKGROUND_REVIEW_APPROVAL_CHANNEL = 'background-review';

function metadataOf(record: DistillCandidateRecord): BackgroundReviewMetadata {
  return (record.metadata || {}) as BackgroundReviewMetadata;
}

function assertBackgroundProposal(
  record: DistillCandidateRecord,
  action: 'pipeline_proposal' | 'skill_patch' | 'memory_consolidation'
): BackgroundReviewMetadata {
  const metadata = metadataOf(record);
  const provenance = metadata.provenance;
  if (
    record.status !== 'proposed' ||
    metadata.origin !== 'background_review_fork' ||
    metadata.action !== action ||
    !provenance ||
    typeof provenance !== 'object' ||
    (provenance as Record<string, unknown>).generated_by !== 'background-review-fork'
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Candidate ${record.candidate_id} is not an eligible background-review pipeline proposal.`
    );
  }
  return metadata;
}

function resolvePipelineTarget(targetRef: unknown): { ref: string; absolute: string } {
  const ref = String(targetRef || '').trim();
  if (!PIPELINE_REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new Error(`[POLICY_VIOLATION] Invalid background-review pipeline target: ${ref}`);
  }
  const absolute = pathResolver.rootResolve(ref);
  const root = pathResolver.rootDir();
  if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    throw new Error(`[POLICY_VIOLATION] Pipeline target escapes repository root: ${ref}`);
  }
  const safeAbsolute = assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
  return { ref, absolute: assertRegularBackgroundTarget(safeAbsolute, ref, 'Pipeline') };
}

function assertRegularBackgroundTarget(filePath: string, ref: string, label: string): string {
  if (!safeExistsSync(filePath)) throw new Error(`${label} target not found: ${ref}`);
  try {
    if (!safeLstat(filePath).isFile()) {
      throw new Error(`[POLICY_VIOLATION] ${label} target must be a regular file: ${ref}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[POLICY_VIOLATION]')) throw error;
    throw new Error(`[POLICY_VIOLATION] ${label} target could not be inspected: ${ref}`);
  }
  return filePath;
}

function parsePipelinePatch(value: unknown): BackgroundPipelineAppendStepPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[POLICY_VIOLATION] Background-review pipeline patch is missing.');
  }
  const patch = value as Record<string, unknown>;
  if (
    patch.operation !== 'append_step' ||
    !patch.step ||
    typeof patch.step !== 'object' ||
    Array.isArray(patch.step)
  ) {
    throw new Error('[POLICY_VIOLATION] Only append_step background-review patches are supported.');
  }
  const step = patch.step as Record<string, unknown>;
  if (typeof step.op !== 'string' || !step.op.trim()) {
    throw new Error('[POLICY_VIOLATION] Pipeline patch step must declare an op.');
  }
  return { operation: 'append_step', step };
}

function parseSkillPatch(value: unknown): BackgroundSkillAppendSectionPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[POLICY_VIOLATION] Background-review skill patch is missing.');
  }
  const patch = value as Record<string, unknown>;
  const section = typeof patch.section === 'string' ? patch.section.trim() : '';
  if (patch.operation !== 'append_section' || !section) {
    throw new Error('[POLICY_VIOLATION] Only append_section skill patches are supported.');
  }
  if (section.length > 8_000 || section.includes('\u0000')) {
    throw new Error('[POLICY_VIOLATION] Skill patch section exceeds the bounded text contract.');
  }
  const heading = section.match(/^## ([^\n\r]+)(?:\r?\n|$)/u);
  if (!heading) {
    throw new Error('[POLICY_VIOLATION] Skill patch section must begin with an H2 heading.');
  }
  return { operation: 'append_section', section };
}

function parseMemoryPatch(value: unknown): BackgroundMemoryConsolidationPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[POLICY_VIOLATION] Background-review memory patch is missing.');
  }
  const patch = value as Record<string, unknown>;
  if (patch.operation !== 'apply_consolidation' || !Array.isArray(patch.actions)) {
    throw new Error('[POLICY_VIOLATION] Memory patches require apply_consolidation actions.');
  }
  const actions: ConsolidationAction[] = [];
  for (const raw of patch.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('[POLICY_VIOLATION] Memory consolidation action must be an object.');
    }
    const action = raw as Record<string, unknown>;
    if (action.kind === 'delete') {
      const index = Number(action.index);
      if (!Number.isSafeInteger(index) || index < 1) {
        throw new Error(
          '[POLICY_VIOLATION] Memory consolidation indexes must be positive integers.'
        );
      }
      actions.push({ kind: 'delete', index });
      continue;
    }
    if (action.kind === 'update' || action.kind === 'add') {
      const text = String(action.text || '').trim();
      if (!text || text.length > 2_000 || text.includes('\u0000')) {
        throw new Error('[POLICY_VIOLATION] Memory consolidation text is empty or unbounded.');
      }
      if (action.kind === 'update') {
        const index = Number(action.index);
        if (!Number.isSafeInteger(index) || index < 1) {
          throw new Error(
            '[POLICY_VIOLATION] Memory consolidation indexes must be positive integers.'
          );
        }
        actions.push({ kind: 'update', index, text });
      } else actions.push({ kind: 'add', text });
      continue;
    }
    throw new Error(
      `[POLICY_VIOLATION] Unknown memory consolidation action: ${String(action.kind)}`
    );
  }
  if (actions.length === 0) {
    throw new Error('[POLICY_VIOLATION] Memory consolidation patch must contain an action.');
  }
  return { operation: 'apply_consolidation', actions };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function backupRef(candidateId: string): string {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error(`[POLICY_VIOLATION] Invalid background-review candidate id: ${candidateId}`);
  }
  return `active/shared/runtime/background-review/patch-backups/${candidateId}-${Date.now()}.json`;
}

function approvalPayload(input: {
  candidateId: string;
  action: 'pipeline_proposal' | 'skill_patch' | 'memory_consolidation';
  targetRef: string;
  expectedSha256: string;
  patch: BackgroundReviewPatch;
}): Record<string, unknown> {
  return {
    version: 1,
    candidate_id: input.candidateId,
    action: input.action,
    operation: input.patch.operation,
    target_ref: input.targetRef,
    expected_sha256: input.expectedSha256,
    patch: input.patch,
  };
}

function approvalEffectBinding(candidateId: string, expectedSha256: string): string {
  return `background-review:${candidateId}:${expectedSha256}`;
}

function assertApprovedBackgroundReviewEffect(input: {
  candidateId: string;
  expectedSha256: string;
  approvalRef: string;
  approvedBy: string;
  action: 'pipeline_proposal' | 'skill_patch' | 'memory_consolidation';
  targetRef: string;
  patch: BackgroundReviewPatch;
}): ApprovalRequestRecord {
  const request = loadApprovalRequest(BACKGROUND_REVIEW_APPROVAL_CHANNEL, input.approvalRef);
  if (!request) {
    throw new Error(
      `[POLICY_VIOLATION] Background-review approval request not found: ${input.approvalRef}`
    );
  }
  if (request.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] Background-review approval request is not approved: ${input.approvalRef}`
    );
  }
  const payload = approvalPayload(input);
  const payloadHash = computeApprovalPayloadHash(payload);
  const effectBinding = approvalEffectBinding(input.candidateId, input.expectedSha256);
  const finalApproval = request.workflow?.approvals.find(
    (approval) => approval.role === 'sovereign'
  );
  if (
    !request.accountability ||
    request.accountability.finalDecision !== 'human_only' ||
    request.accountability.payloadHash !== payloadHash ||
    request.accountability.effectBinding !== effectBinding ||
    !request.decidedBy ||
    request.decidedBy !== input.approvedBy ||
    !finalApproval ||
    finalApproval.status !== 'approved' ||
    finalApproval.decidedByType !== 'human' ||
    finalApproval.authenticated !== true ||
    finalApproval.payloadHash !== payloadHash ||
    finalApproval.effectBinding !== effectBinding
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Background-review approval is not bound to this human-approved effect: ${input.approvalRef}`
    );
  }
  return request;
}

/** Create a pending human approval for one exact background-review effect. */
export function inspectBackgroundReviewProposal(
  candidateIdInput: string
): BackgroundReviewApprovalPreview {
  const candidateId = String(candidateIdInput || '').trim();
  if (!candidateId) {
    throw new Error('[POLICY_VIOLATION] candidateId is required.');
  }
  const record = loadDistillCandidateRecord(candidateId);
  if (!record) throw new Error(`Background-review candidate not found: ${candidateId}`);
  const metadata = metadataOf(record);
  const action = metadata.action;
  if (
    action !== 'pipeline_proposal' &&
    action !== 'skill_patch' &&
    action !== 'memory_consolidation'
  ) {
    throw new Error(`[POLICY_VIOLATION] Candidate ${candidateId} is not an approval-bound patch.`);
  }
  const proposal = assertBackgroundProposal(record, action);
  const target =
    action === 'pipeline_proposal'
      ? resolvePipelineTarget(proposal.target_ref)
      : action === 'skill_patch'
        ? resolveManagedSkillTarget(proposal.target_ref)
        : resolveMemoryTarget(proposal.target_ref);
  const before = readTextFile(target.absolute);
  const patch =
    action === 'pipeline_proposal'
      ? parsePipelinePatch(proposal.patch)
      : action === 'skill_patch'
        ? parseSkillPatch(proposal.patch)
        : parseMemoryPatch(proposal.patch);
  return {
    candidateId,
    action,
    targetRef: target.ref,
    expectedSha256: sha256(before),
    patch,
  };
}

export function createBackgroundReviewApprovalRequest(
  input: BackgroundReviewApprovalRequestInput
): ApprovalRequestRecord {
  const candidateId = String(input.candidateId || '').trim();
  const expectedSha256 = String(input.expectedSha256 || '')
    .trim()
    .toLowerCase();
  if (!candidateId || !SHA256_PATTERN.test(expectedSha256)) {
    throw new Error('[POLICY_VIOLATION] candidateId and expectedSha256 are required.');
  }
  const preview = inspectBackgroundReviewProposal(candidateId);
  if (preview.expectedSha256 !== expectedSha256) {
    throw new Error(
      `[POLICY_VIOLATION] Background-review approval pre-image hash mismatch for ${preview.targetRef}: expected ${expectedSha256}, got ${preview.expectedSha256}`
    );
  }
  const payload = approvalPayload({
    candidateId,
    action: preview.action,
    targetRef: preview.targetRef,
    expectedSha256,
    patch: preview.patch,
  });
  const payloadHash = computeApprovalPayloadHash(payload);
  const effectBinding = approvalEffectBinding(candidateId, expectedSha256);
  const existing = listApprovalRequests({
    storageChannels: [BACKGROUND_REVIEW_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (request) =>
      request.correlationId === candidateId &&
      request.accountability?.payloadHash === payloadHash &&
      request.accountability?.effectBinding === effectBinding
  );
  if (existing) return existing;
  return createApprovalRequest('mission_controller', {
    channel: BACKGROUND_REVIEW_APPROVAL_CHANNEL,
    storageChannel: BACKGROUND_REVIEW_APPROVAL_CHANNEL,
    threadTs: input.approvalThreadTs?.trim() || candidateId,
    ...(input.approvalChannel?.trim() ? { channel: input.approvalChannel.trim() } : {}),
    correlationId: candidateId,
    requestedBy: input.requestedBy?.trim() || 'background-review-fork',
    draft: {
      title: `Approve background-review ${preview.patch.operation}: ${preview.targetRef}`,
      summary: `Human approval is required to apply candidate ${candidateId}.`,
      details: JSON.stringify(payload),
      severity: 'medium',
    },
    kind: 'channel-approval',
    requestedByContext: {
      surface: 'system',
      actorId: input.requestedBy?.trim() || 'background-review-fork',
      actorRole: 'background-review-fork',
      missionId: input.missionId,
    },
    justification: {
      reason: 'Apply an evidence-backed background-review proposal after human review.',
      requestedEffects: [preview.patch.operation, preview.targetRef],
    },
    risk: { level: 'medium', restartScope: 'manual', requiresStrongAuth: false },
    workflow: {
      workflowId: `background-review-human-${candidateId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      currentStage: 'final',
      stages: [{ stageId: 'final', requiredRoles: ['sovereign'] }],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
    },
  });
}

/** Apply one explicitly approved, hash-bound pipeline patch. */
export function applyBackgroundReviewPipelinePatch(
  input: ApplyBackgroundReviewPipelinePatchInput
): ApplyBackgroundReviewPipelinePatchResult {
  assertBackgroundReviewOperationAllowed('pipeline:promote');
  const candidateId = String(input.candidateId || '').trim();
  const expectedSha256 = String(input.expectedSha256 || '')
    .trim()
    .toLowerCase();
  const approvedBy = String(input.approvedBy || '').trim();
  const approvalRef = String(input.approvalRef || '').trim();
  if (!candidateId || !approvedBy || !approvalRef) {
    throw new Error('candidateId, approvedBy, and approvalRef are required for patch application.');
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error('[POLICY_VIOLATION] expectedSha256 must be a lowercase SHA-256 digest.');
  }

  const record = loadDistillCandidateRecord(candidateId);
  if (!record) throw new Error(`Background-review candidate not found: ${candidateId}`);
  const metadata = assertBackgroundProposal(record, 'pipeline_proposal');
  const target = resolvePipelineTarget(metadata.target_ref);
  const patch = parsePipelinePatch(metadata.patch);
  if (!safeExistsSync(target.absolute)) throw new Error(`Pipeline target not found: ${target.ref}`);

  const before = readTextFile(target.absolute);
  const beforeSha256 = sha256(before);
  if (beforeSha256 !== expectedSha256) {
    throw new Error(
      `[POLICY_VIOLATION] Pipeline pre-image hash mismatch for ${target.ref}: expected ${expectedSha256}, got ${beforeSha256}`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseSafeJsonInput(before, 'pipeline target') as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Pipeline target is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const steps = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!steps)
    throw new Error(`[POLICY_VIOLATION] Pipeline target has no steps array: ${target.ref}`);
  const nextPipeline = { ...parsed, steps: [...steps, patch.step] };
  const validated = validatePipelineAdf(nextPipeline);
  const guardrails = validatePipelineGuardrails(validated, target.ref);
  if (!guardrails.ok) {
    throw new Error(
      `[POLICY_VIOLATION] Patched pipeline fails guardrails: ${guardrails.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => `${finding.code}: ${finding.message}`)
        .join('; ')}`
    );
  }

  const nextContent = `${JSON.stringify(validated, null, 2)}\n`;
  assertApprovedBackgroundReviewEffect({
    candidateId,
    expectedSha256,
    approvalRef,
    approvedBy,
    action: 'pipeline_proposal',
    targetRef: target.ref,
    patch,
  });
  const afterSha256 = sha256(nextContent);
  const backup = backupRef(candidateId);
  const backupPayload = {
    version: 1,
    candidate_id: candidateId,
    target_ref: target.ref,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
    approval_ref: approvalRef,
    backed_up_at: nowIso(),
    original_content: before,
  };

  withExecutionContext('ecosystem_architect', () => {
    const backupPath = assertSafeRepositoryPath(pathResolver.rootResolve(backup), {
      allowMissingLeaf: true,
    });
    const backupDir = path.dirname(backupPath);
    if (!safeExistsSync(backupDir)) safeMkdir(backupDir, { recursive: true });
    safeWriteFile(backupPath, `${JSON.stringify(backupPayload, null, 2)}\n`);
    safeWriteFile(target.absolute, nextContent);
  });

  updateDistillCandidateRecord(candidateId, {
    status: 'promoted',
    promoted_ref: target.ref,
    metadata: {
      ...metadata,
      patch_application: {
        operation: patch.operation,
        target_ref: target.ref,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        backup_ref: backup,
        approved_by: approvedBy,
        approval_ref: approvalRef,
        applied_at: nowIso(),
      },
    },
  });

  return {
    candidate_id: candidateId,
    target_ref: target.ref,
    backup_ref: backup,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
  };
}

export interface ManagedSkillProvenance {
  version: 1;
  managed_by: 'background-review';
  owner: 'background-review-agent';
  skill_ref: string;
  allow_append_only: true;
  registered_by: string;
}

function managedSkillProvenanceCatalog(sidecarPath: string) {
  return defineCatalog<ManagedSkillProvenance>({
    id: 'background-review-managed-skill-provenance',
    path: sidecarPath,
    schema: MANAGED_SKILL_PROVENANCE_SCHEMA_PATH,
  });
}

/** Load managed-skill provenance through schema, regular-file, and skill binding checks. */
export function loadManagedSkillProvenanceAtPath(
  sidecarPath: string,
  skillRef: string
): ManagedSkillProvenance {
  const safeSidecarPath = assertSafeRepositoryPath(sidecarPath, { allowMissingLeaf: true });
  if (!safeLstat(safeSidecarPath).isFile()) {
    throw new Error(
      `[POLICY_VIOLATION] Managed skill provenance must be a regular file: ${sidecarPath}`
    );
  }
  const provenance = managedSkillProvenanceCatalog(safeSidecarPath).load();
  if (provenance.skill_ref !== skillRef) {
    throw new Error(
      `[POLICY_VIOLATION] Managed skill provenance skill reference mismatch: ${skillRef}`
    );
  }
  return provenance;
}

function resolveManagedSkillTarget(targetRef: unknown): {
  ref: string;
  absolute: string;
  provenance: ManagedSkillProvenance;
} {
  const ref = String(targetRef || '').trim();
  if (!MANAGED_SKILL_REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new Error(`[POLICY_VIOLATION] Invalid background-review managed skill target: ${ref}`);
  }
  const absolute = pathResolver.rootResolve(ref);
  const root = pathResolver.rootDir();
  if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    throw new Error(`[POLICY_VIOLATION] Skill target escapes repository root: ${ref}`);
  }
  const safeAbsolute = assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
  const regularSkillPath = assertRegularBackgroundTarget(safeAbsolute, ref, 'Skill');

  const sidecar = assertSafeRepositoryPath(
    path.join(path.dirname(regularSkillPath), 'provenance.json'),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(sidecar)) {
    throw new Error(`[POLICY_VIOLATION] Managed skill provenance sidecar is missing: ${ref}`);
  }
  let provenance: ManagedSkillProvenance;
  try {
    provenance = loadManagedSkillProvenanceAtPath(sidecar, ref);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid catalog')) {
      throw new Error(`[POLICY_VIOLATION] Managed skill provenance is not valid: ${error.message}`);
    }
    throw new Error(
      `[POLICY_VIOLATION] Managed skill provenance is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    provenance.version !== 1 ||
    provenance.managed_by !== 'background-review' ||
    provenance.owner !== 'background-review-agent' ||
    provenance.skill_ref !== ref ||
    provenance.allow_append_only !== true ||
    typeof provenance.registered_by !== 'string' ||
    !provenance.registered_by.trim() ||
    provenance.registered_by === 'background-review-fork'
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Managed skill provenance does not authorize append-only patching: ${ref}`
    );
  }
  return { ref, absolute: regularSkillPath, provenance };
}

function resolveMemoryTarget(targetRef: unknown): { ref: string; absolute: string } {
  const ref = String(targetRef || '').trim();
  if (!MEMORY_NOTEBOOK_REF_PATTERN.test(ref) || ref.includes('..')) {
    throw new Error(`[POLICY_VIOLATION] Invalid background-review memory target: ${ref}`);
  }
  const absolute = pathResolver.rootResolve(ref);
  const root = pathResolver.rootDir();
  if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
    throw new Error(`[POLICY_VIOLATION] Memory target escapes repository root: ${ref}`);
  }
  const safeAbsolute = assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
  return { ref, absolute: assertRegularBackgroundTarget(safeAbsolute, ref, 'Memory') };
}

function applySkillSection(content: string, section: string): string {
  const heading = section.match(/^## ([^\n\r]+)(?:\r?\n|$)/u)?.[1]?.trim();
  if (!heading) throw new Error('[POLICY_VIOLATION] Skill patch section heading is missing.');
  const duplicateHeading = new RegExp(
    `^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'mu'
  );
  if (duplicateHeading.test(content)) {
    throw new Error(`[POLICY_VIOLATION] Skill already contains the requested section: ${heading}`);
  }
  return `${content.trimEnd()}\n\n${section}\n`;
}

/** Apply one explicitly approved, hash-bound consolidation to a notebook. */
export function applyBackgroundReviewMemoryConsolidationPatch(
  input: ApplyBackgroundReviewPipelinePatchInput
): ApplyBackgroundReviewPipelinePatchResult {
  assertBackgroundReviewOperationAllowed('memory:consolidate');
  const candidateId = String(input.candidateId || '').trim();
  const expectedSha256 = String(input.expectedSha256 || '')
    .trim()
    .toLowerCase();
  const approvedBy = String(input.approvedBy || '').trim();
  const approvalRef = String(input.approvalRef || '').trim();
  if (!candidateId || !approvedBy || !approvalRef) {
    throw new Error('candidateId, approvedBy, and approvalRef are required for patch application.');
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error('[POLICY_VIOLATION] expectedSha256 must be a lowercase SHA-256 digest.');
  }

  const record = loadDistillCandidateRecord(candidateId);
  if (!record) throw new Error(`Background-review candidate not found: ${candidateId}`);
  const metadata = assertBackgroundProposal(record, 'memory_consolidation');
  const target = resolveMemoryTarget(metadata.target_ref);
  const patch = parseMemoryPatch(metadata.patch);
  const before = readTextFile(target.absolute);
  const beforeSha256 = sha256(before);
  if (beforeSha256 !== expectedSha256) {
    throw new Error(
      `[POLICY_VIOLATION] Memory pre-image hash mismatch for ${target.ref}: expected ${expectedSha256}, got ${beforeSha256}`
    );
  }
  const nextContent = applyConsolidationActions(before, patch.actions, Date.now());
  if (nextContent === before) {
    throw new Error('[POLICY_VIOLATION] Memory consolidation proposal produces no change.');
  }
  assertApprovedBackgroundReviewEffect({
    candidateId,
    expectedSha256,
    approvalRef,
    approvedBy,
    action: 'memory_consolidation',
    targetRef: target.ref,
    patch,
  });
  const afterSha256 = sha256(nextContent);
  const backup = backupRef(candidateId);
  const backupPayload = {
    version: 1,
    candidate_id: candidateId,
    target_ref: target.ref,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
    approval_ref: approvalRef,
    backed_up_at: nowIso(),
    original_content: before,
  };

  withExecutionContext('ecosystem_architect', () => {
    const backupPath = assertSafeRepositoryPath(pathResolver.rootResolve(backup), {
      allowMissingLeaf: true,
    });
    const backupDir = path.dirname(backupPath);
    if (!safeExistsSync(backupDir)) safeMkdir(backupDir, { recursive: true });
    safeWriteFile(backupPath, `${JSON.stringify(backupPayload, null, 2)}\n`);
    safeWriteFile(target.absolute, nextContent);
  });

  updateDistillCandidateRecord(candidateId, {
    status: 'promoted',
    promoted_ref: target.ref,
    metadata: {
      ...metadata,
      patch_application: {
        operation: patch.operation,
        target_ref: target.ref,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        backup_ref: backup,
        approved_by: approvedBy,
        approval_ref: approvalRef,
        applied_at: nowIso(),
      },
    },
  });

  return {
    candidate_id: candidateId,
    target_ref: target.ref,
    backup_ref: backup,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
  };
}

/** Apply one explicitly approved, provenance-bound append-only skill patch. */
export function applyBackgroundReviewSkillPatch(
  input: ApplyBackgroundReviewPipelinePatchInput
): ApplyBackgroundReviewPipelinePatchResult {
  assertBackgroundReviewOperationAllowed('skill:patch');
  const candidateId = String(input.candidateId || '').trim();
  const expectedSha256 = String(input.expectedSha256 || '')
    .trim()
    .toLowerCase();
  const approvedBy = String(input.approvedBy || '').trim();
  const approvalRef = String(input.approvalRef || '').trim();
  if (!candidateId || !approvedBy || !approvalRef) {
    throw new Error('candidateId, approvedBy, and approvalRef are required for patch application.');
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error('[POLICY_VIOLATION] expectedSha256 must be a lowercase SHA-256 digest.');
  }

  const record = loadDistillCandidateRecord(candidateId);
  if (!record) throw new Error(`Background-review candidate not found: ${candidateId}`);
  const metadata = assertBackgroundProposal(record, 'skill_patch');
  const target = resolveManagedSkillTarget(metadata.target_ref);
  const patch = parseSkillPatch(metadata.patch);
  const before = readTextFile(target.absolute);
  const beforeSha256 = sha256(before);
  if (beforeSha256 !== expectedSha256) {
    throw new Error(
      `[POLICY_VIOLATION] Skill pre-image hash mismatch for ${target.ref}: expected ${expectedSha256}, got ${beforeSha256}`
    );
  }

  const nextContent = applySkillSection(before, patch.section);
  assertApprovedBackgroundReviewEffect({
    candidateId,
    expectedSha256,
    approvalRef,
    approvedBy,
    action: 'skill_patch',
    targetRef: target.ref,
    patch,
  });
  const afterSha256 = sha256(nextContent);
  const backup = backupRef(candidateId);
  const backupPayload = {
    version: 1,
    candidate_id: candidateId,
    target_ref: target.ref,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
    approval_ref: approvalRef,
    backed_up_at: nowIso(),
    original_content: before,
  };

  withExecutionContext('ecosystem_architect', () => {
    const backupPath = assertSafeRepositoryPath(pathResolver.rootResolve(backup), {
      allowMissingLeaf: true,
    });
    const backupDir = path.dirname(backupPath);
    if (!safeExistsSync(backupDir)) safeMkdir(backupDir, { recursive: true });
    safeWriteFile(backupPath, `${JSON.stringify(backupPayload, null, 2)}\n`);
    safeWriteFile(target.absolute, nextContent);
  });

  updateDistillCandidateRecord(candidateId, {
    status: 'promoted',
    promoted_ref: target.ref,
    metadata: {
      ...metadata,
      patch_application: {
        operation: patch.operation,
        target_ref: target.ref,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        backup_ref: backup,
        approved_by: approvedBy,
        approval_ref: approvalRef,
        applied_at: nowIso(),
      },
    },
  });

  return {
    candidate_id: candidateId,
    target_ref: target.ref,
    backup_ref: backup,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    approved_by: approvedBy,
  };
}
