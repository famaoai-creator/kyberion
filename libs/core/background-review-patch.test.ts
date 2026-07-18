import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  applyBackgroundReviewPipelinePatch,
  applyBackgroundReviewSkillPatch,
  createBackgroundReviewApprovalRequest,
} from './background-review-patch.js';
import { approvalRequestLogicalPath, decideApprovalRequest } from './approval-store.js';

const createdCandidateIds: string[] = [];
const createdPipelineRefs: string[] = [];
const createdSkillDirs: string[] = [];
const createdBackupRefs: string[] = [];
const createdApprovalRefs: string[] = [];

function targetRef(suffix: string): string {
  const ref = `pipelines/background-review-patch-test-${process.pid}-${suffix}.json`;
  createdPipelineRefs.push(ref);
  return ref;
}

function writePipeline(ref: string, content: unknown): string {
  const absolute = pathResolver.rootResolve(ref);
  withExecutionContext('ecosystem_architect', () =>
    safeWriteFile(absolute, `${JSON.stringify(content, null, 2)}\n`)
  );
  return String(safeReadFile(absolute, { encoding: 'utf8' }));
}

function writeManagedSkill(suffix: string, registeredBy = 'operator-test'): string {
  const ref = `active/shared/runtime/background-review/skills/patch-test-${process.pid}-${suffix}/SKILL.md`;
  const absolute = pathResolver.rootResolve(ref);
  const dir = pathResolver.rootResolve(ref.slice(0, ref.lastIndexOf('/')));
  createdSkillDirs.push(dir);
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      absolute,
      '# Managed review skill\n\n## Existing guidance\n\nExisting guidance.\n'
    );
    safeWriteFile(
      pathResolver.rootResolve(`${ref.slice(0, ref.lastIndexOf('/'))}/provenance.json`),
      `${JSON.stringify(
        {
          version: 1,
          managed_by: 'background-review',
          owner: 'background-review-agent',
          skill_ref: ref,
          allow_append_only: true,
          registered_by: registeredBy,
        },
        null
      )}\n`
    );
  });
  return ref;
}

function saveProposal(input: {
  candidateId: string;
  targetRef: string;
  patch: Record<string, unknown>;
  origin?: string;
  action?: 'pipeline_proposal' | 'skill_patch';
}) {
  const action = input.action || 'pipeline_proposal';
  const record = createDistillCandidateRecord({
    candidate_id: input.candidateId,
    source_type: 'task_session',
    task_session_id: 'PATCH-TEST-SESSION',
    title: 'Background pipeline patch test',
    summary: 'A reviewed pipeline patch proposal.',
    status: 'proposed',
    target_kind: action === 'pipeline_proposal' ? 'sop_candidate' : 'pattern',
    evidence_refs: [`surface:test:background-review:${input.candidateId}`],
    metadata: {
      origin: input.origin || 'background_review_fork',
      action,
      target_ref: input.targetRef,
      patch: input.patch,
      provenance: {
        generated_by: 'background-review-fork',
        session_id: 'PATCH-TEST-SESSION',
      },
    },
  });
  withExecutionContext('surface_runtime', () => saveDistillCandidateRecord(record));
  createdCandidateIds.push(record.candidate_id);
  return record;
}

function approvePatch(candidateId: string, before: string): string {
  const request = createBackgroundReviewApprovalRequest({
    candidateId,
    expectedSha256: createHash('sha256').update(before).digest('hex'),
    requestedBy: 'background-review-fork-test',
    missionId: 'MSN-BACKGROUND-REVIEW-PATCH-TEST',
  });
  createdApprovalRefs.push(request.id);
  const decided = decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: 'approved',
    decidedBy: 'operator-test',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
  });
  expect(decided.status).toBe('approved');
  return request.id;
}

afterEach(() => {
  withExecutionContext('ecosystem_architect', () => {
    for (const ref of createdPipelineRefs.splice(0)) {
      safeRmSync(pathResolver.rootResolve(ref), { force: true });
    }
    for (const dir of createdSkillDirs.splice(0)) {
      safeRmSync(dir, { recursive: true, force: true });
    }
    for (const ref of createdBackupRefs.splice(0)) {
      safeRmSync(pathResolver.rootResolve(ref), { force: true });
    }
    for (const candidateId of createdCandidateIds.splice(0)) {
      safeRmSync(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`), {
        force: true,
      });
    }
  });
  withExecutionContext('mission_controller', () => {
    for (const approvalId of createdApprovalRefs.splice(0)) {
      safeRmSync(
        pathResolver.rootResolve(approvalRequestLogicalPath('background-review', approvalId)),
        { force: true }
      );
    }
  });
});

describe('background-review-patch', () => {
  it('applies an approved hash-bound append step and keeps a backup', () => {
    const ref = targetRef('success');
    const before = writePipeline(ref, {
      action: 'pipeline',
      name: 'background-review-patch-test',
      version: '1.0.0',
      steps: [{ id: 'before', role: 'sink', op: 'system:log', params: { message: 'before' } }],
    });
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-SUCCESS`,
      targetRef: ref,
      patch: {
        operation: 'append_step',
        step: { id: 'after', role: 'sink', op: 'system:log', params: { message: 'after' } },
      },
    });

    const result = applyBackgroundReviewPipelinePatch({
      candidateId: candidate.candidate_id,
      expectedSha256: createHash('sha256').update(before).digest('hex'),
      approvedBy: 'operator-test',
      approvalRef: approvePatch(candidate.candidate_id, before),
    });
    createdBackupRefs.push(result.backup_ref);

    const patched = JSON.parse(
      safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' }) as string
    );
    expect(result).toMatchObject({ target_ref: ref, approved_by: 'operator-test' });
    expect(patched.steps).toHaveLength(2);
    expect(loadDistillCandidateRecord(candidate.candidate_id)).toMatchObject({
      status: 'promoted',
      promoted_ref: ref,
      metadata: { patch_application: { backup_ref: result.backup_ref } },
    });
    expect(
      safeReadFile(pathResolver.rootResolve(result.backup_ref), { encoding: 'utf8' })
    ).toContain('original_content');
  });

  it('rejects a stale pre-image hash before writing', () => {
    const ref = targetRef('hash-mismatch');
    const before = writePipeline(ref, {
      action: 'pipeline',
      name: 'background-review-patch-test',
      version: '1.0.0',
      steps: [],
    });
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-HASH`,
      targetRef: ref,
      patch: { operation: 'append_step', step: { op: 'system:log', params: { message: 'x' } } },
    });

    expect(() =>
      applyBackgroundReviewPipelinePatch({
        candidateId: candidate.candidate_id,
        expectedSha256: '0'.repeat(64),
        approvedBy: 'operator-test',
        approvalRef: 'approval-test-2',
      })
    ).toThrow(/pre-image hash mismatch/);
    expect(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' })).toBe(before);
    expect(loadDistillCandidateRecord(candidate.candidate_id)?.status).toBe('proposed');
  });

  it('rejects a patch that fails pipeline guardrails', () => {
    const ref = targetRef('guardrail');
    const before = writePipeline(ref, {
      action: 'pipeline',
      name: 'background-review-patch-test',
      version: '1.0.0',
      steps: [],
    });
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-GUARD`,
      targetRef: ref,
      patch: {
        operation: 'append_step',
        step: {
          op: 'system:log',
          params: {},
          hooks: { before: [{ type: 'command', cmd: 'rm -rf /' }] },
        },
      },
    });

    expect(() =>
      applyBackgroundReviewPipelinePatch({
        candidateId: candidate.candidate_id,
        expectedSha256: createHash('sha256').update(before).digest('hex'),
        approvedBy: 'operator-test',
        approvalRef: 'approval-test-3',
      })
    ).toThrow(/guardrails/);
    expect(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' })).toBe(before);
  });

  it('protects records without the background-review provenance marker', () => {
    const ref = targetRef('manual');
    const before = writePipeline(ref, {
      action: 'pipeline',
      name: 'background-review-patch-test',
      version: '1.0.0',
      steps: [],
    });
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-MANUAL`,
      targetRef: ref,
      origin: 'manual',
      patch: { operation: 'append_step', step: { op: 'system:log', params: {} } },
    });

    expect(() =>
      applyBackgroundReviewPipelinePatch({
        candidateId: candidate.candidate_id,
        expectedSha256: createHash('sha256').update(before).digest('hex'),
        approvedBy: 'operator-test',
        approvalRef: 'approval-test-4',
      })
    ).toThrow(/POLICY_VIOLATION/);
  });

  it('applies an approved append-only section to a registered managed skill', () => {
    const ref = writeManagedSkill('success');
    const before = String(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' }));
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-SKILL-SUCCESS`,
      targetRef: ref,
      action: 'skill_patch',
      patch: {
        operation: 'append_section',
        section: '## Review checklist\n\nVerify the output before promotion.',
      },
    });

    const result = applyBackgroundReviewSkillPatch({
      candidateId: candidate.candidate_id,
      expectedSha256: createHash('sha256').update(before).digest('hex'),
      approvedBy: 'operator-test',
      approvalRef: approvePatch(candidate.candidate_id, before),
    });
    createdBackupRefs.push(result.backup_ref);

    expect(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' })).toContain(
      '## Review checklist'
    );
    expect(loadDistillCandidateRecord(candidate.candidate_id)).toMatchObject({
      status: 'promoted',
      promoted_ref: ref,
      metadata: { patch_application: { operation: 'append_section' } },
    });
  });

  it('rejects a skill target without the managed provenance sidecar', () => {
    const ref = writeManagedSkill('missing-sidecar');
    safeRmSync(pathResolver.rootResolve(`${ref.slice(0, ref.lastIndexOf('/'))}/provenance.json`), {
      force: true,
    });
    const before = String(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' }));
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-SKILL-SIDECAR`,
      targetRef: ref,
      action: 'skill_patch',
      patch: { operation: 'append_section', section: '## Should fail\n\nNo sidecar.' },
    });

    expect(() =>
      applyBackgroundReviewSkillPatch({
        candidateId: candidate.candidate_id,
        expectedSha256: createHash('sha256').update(before).digest('hex'),
        approvedBy: 'operator-test',
        approvalRef: 'approval-skill-2',
      })
    ).toThrow(/provenance sidecar/);
    expect(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' })).toBe(before);
  });

  it('rejects duplicate sections and bundled skill paths', () => {
    const ref = writeManagedSkill('duplicate');
    const before = String(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' }));
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-SKILL-DUPLICATE`,
      targetRef: ref,
      action: 'skill_patch',
      patch: {
        operation: 'append_section',
        section: '## Existing guidance\n\nThis heading already exists.',
      },
    });
    expect(() =>
      applyBackgroundReviewSkillPatch({
        candidateId: candidate.candidate_id,
        expectedSha256: createHash('sha256').update(before).digest('hex'),
        approvedBy: 'operator-test',
        approvalRef: 'approval-skill-3',
      })
    ).toThrow(/already contains/);

    const bundledCandidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-SKILL-BUNDLED`,
      targetRef: 'plugins/kyberion/SKILL.md',
      action: 'skill_patch',
      patch: { operation: 'append_section', section: '## Not allowed\n\nBundled.' },
    });
    expect(() =>
      applyBackgroundReviewSkillPatch({
        candidateId: bundledCandidate.candidate_id,
        expectedSha256: '0'.repeat(64),
        approvedBy: 'operator-test',
        approvalRef: 'approval-skill-4',
      })
    ).toThrow(/Invalid background-review managed skill target/);
  });

  it('rejects an arbitrary approval reference even when the patch is otherwise valid', () => {
    const ref = targetRef('approval-binding');
    const before = writePipeline(ref, {
      action: 'pipeline',
      name: 'background-review-patch-test',
      version: '1.0.0',
      steps: [],
    });
    const candidate = saveProposal({
      candidateId: `PATCH-TEST-${process.pid}-APPROVAL-BINDING`,
      targetRef: ref,
      patch: { operation: 'append_step', step: { op: 'system:log', params: {} } },
    });

    expect(() =>
      applyBackgroundReviewPipelinePatch({
        candidateId: candidate.candidate_id,
        expectedSha256: createHash('sha256').update(before).digest('hex'),
        approvedBy: 'operator-test',
        approvalRef: '00000000-0000-0000-0000-000000000000',
      })
    ).toThrow(/approval request not found/);
    expect(safeReadFile(pathResolver.rootResolve(ref), { encoding: 'utf8' })).toBe(before);
  });
});
