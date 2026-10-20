/** Independent publication proof; a recorded promotion reference is not proof. */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { parseSafeJsonInput } from '../foundation/json.js';
import { readTextFile } from '../foundation/text.js';
import { safeLstat, safeRealpath, assertSafeRepositoryPath } from '../secure-io.js';
import {
  buildPromotedMemoryRecord,
  buildPromotedMemoryMarkdown,
  type PromotedMemoryRecord,
} from '../promoted-memory-builder.js';
import { normalizeMemoryFact } from './memory-notebook.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
import { assertScopedLearningApproval } from './scoped-learning-approval-verification.js';
import {
  assertScopedLearningScope,
  scopedLearningMarkdownPath,
  learningSha256,
  type ScopedLearningPublicationIdentity,
} from './scoped-learning-contract.js';
export {
  assertScopedLearningScope,
  approvedLearningPayloadDigest,
  type ScopedLearningPublicationIdentity,
} from './scoped-learning-contract.js';

function regularPublicationPath(relative: string): string {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(relative));
  if (path.resolve(safeRealpath(absolute)) !== path.resolve(absolute))
    throw new Error('[LEARNING_PUBLICATION_INVALID] Symbolic link');
  if (!safeLstat(absolute).isFile())
    throw new Error('[LEARNING_PUBLICATION_INVALID] Not a regular file');
  return absolute;
}
/** Called only after the governed publisher writes both files; recomputes from disk. */
export function inspectScopedLearningPublication(
  candidate: MemoryCandidate
): ScopedLearningPublicationIdentity {
  const approval = assertScopedLearningApproval(candidate);
  const scope = assertScopedLearningScope(candidate.scope!);
  const markdownPath = scopedLearningMarkdownPath(scope, candidate.candidate_id);
  const recordPath = markdownPath.replace(/\.md$/, '.json');
  if (candidate.promoted_ref && candidate.promoted_ref !== markdownPath)
    throw new Error('[LEARNING_PUBLICATION_INVALID] Unexpected publication reference');
  const jsonFile = regularPublicationPath(recordPath);
  const mdFile = regularPublicationPath(markdownPath);
  const jsonBytes = readTextFile(jsonFile);
  const record = parseSafeJsonInput(
    jsonBytes,
    'scoped learning publication'
  ) as PromotedMemoryRecord;
  assertScopedLearningRecord(candidate, record);
  const mdBytes = readTextFile(mdFile);
  if (mdBytes !== buildPromotedMemoryMarkdown(record))
    throw new Error('[LEARNING_PUBLICATION_INVALID] Markdown differs from record');
  return {
    version: 1,
    candidate_id: candidate.candidate_id,
    scope,
    approved_payload_digest: approval.payload_digest,
    record_path: recordPath,
    markdown_path: markdownPath,
    record_sha256: learningSha256(jsonBytes),
    markdown_sha256: learningSha256(mdBytes),
  };
}
export function assertScopedLearningRecord(
  candidate: MemoryCandidate,
  record: PromotedMemoryRecord | null
): asserts record is PromotedMemoryRecord {
  const approval = assertScopedLearningApproval(candidate);
  const scope = assertScopedLearningScope(candidate.scope!);
  if (
    !record ||
    record.kind !== 'sop_candidate' ||
    record.knowledge_domain !== 'organization' ||
    record.tier !== 'confidential' ||
    record.candidate_id !== candidate.candidate_id ||
    record.record_id !== candidate.candidate_id ||
    JSON.stringify(record.scope) !== JSON.stringify(scope) ||
    record.approved_payload_digest !== approval.payload_digest
  )
    throw new Error('[LEARNING_PUBLICATION_INVALID] Published identity differs from approval');
  const expectedSummary = normalizeMemoryFact(
    candidate.curation?.summary || candidate.summary,
    Date.parse(candidate.queued_at) || Date.now()
  );
  const expectedTitle =
    candidate.curation?.title ||
    expectedSummary.slice(0, 80) ||
    'Memory candidate ' + candidate.candidate_id;
  if (
    record.title !== expectedTitle ||
    record.summary !== expectedSummary ||
    JSON.stringify(record.procedure_steps) !==
      JSON.stringify([(candidate.curation?.content || candidate.summary).trim()]) ||
    JSON.stringify(record.evidence_refs) !==
      JSON.stringify(candidate.curation?.evidence_refs || candidate.evidence_refs)
  )
    throw new Error('[LEARNING_PUBLICATION_INVALID] Published content differs from approval');
  const source = candidate.source_ref;
  const expected = buildPromotedMemoryRecord({
    candidate_id: candidate.candidate_id,
    source_type:
      candidate.source_type === 'mission'
        ? 'mission'
        : candidate.source_type === 'task_session'
          ? 'task_session'
          : 'artifact',
    tier: 'confidential',
    scope,
    title: expectedTitle,
    summary: expectedSummary,
    status: 'proposed',
    target_kind: 'sop_candidate',
    evidence_refs: candidate.curation?.evidence_refs || candidate.evidence_refs,
    ...(source.startsWith('task_session:')
      ? { task_session_id: source.slice('task_session:'.length).trim() || undefined }
      : {}),
    ...(source.startsWith('artifact:')
      ? { artifact_ids: [source.slice('artifact:'.length).trim()] }
      : {}),
    created_at: record.created_at,
    updated_at: record.created_at,
    metadata: {
      knowledge_domain: 'organization',
      approved_payload_digest: approval.payload_digest,
      procedure_steps: [candidate.curation?.content || candidate.summary],
    },
  });
  // Only timestamp and checkout provenance are nonsemantic publisher-generated fields.
  const semantic = (value: PromotedMemoryRecord) => {
    const normalized = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    delete normalized.created_at;
    delete normalized.source_branch;
    delete normalized.source_commit;
    return JSON.stringify(
      Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)))
    );
  };
  if (semantic(record) !== semantic(expected))
    throw new Error(
      '[LEARNING_PUBLICATION_INVALID] Published semantic record differs from approval'
    );
}
export function verifyScopedLearningPublication(
  candidate: MemoryCandidate
): ScopedLearningPublicationIdentity | undefined {
  try {
    if (candidate.status !== 'promoted' || !candidate.learning_publication) return undefined;
    const observed = inspectScopedLearningPublication(candidate);
    return JSON.stringify(observed) === JSON.stringify(candidate.learning_publication)
      ? observed
      : undefined;
  } catch {
    return undefined;
  }
}
