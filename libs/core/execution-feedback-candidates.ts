/** Feedback-only scoped storage. Existing global distill APIs remain unchanged. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import { physicalScopedPath } from './physical-namespace.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './knowledge/memory-scope.js';
import {
  loadDistillCandidateRecord,
  listDistillCandidateRecords,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
} from './knowledge/distill-candidate-registry.js';

export function executionFeedbackScopeKey(scope?: MemoryScopeEnvelope): string {
  if (!scope) return 'unscoped-legacy';
  const canonical = assertMemoryScope(scope);
  if (
    Object.entries(scope).some(
      ([key, value]) => value !== undefined && !Object.hasOwn(canonical, key)
    )
  ) {
    throw new Error(
      '[FEEDBACK_SCOPE_UNSUPPORTED] Unknown or non-canonical scope fields cannot be dropped'
    );
  }
  return JSON.stringify(canonical);
}
export function executionFeedbackScopeRoot(scope: MemoryScopeEnvelope): string {
  const scopeKey = executionFeedbackScopeKey(scope);
  const canonical = assertMemoryScope(scope);
  if (!canonical.tenant_slug)
    throw new Error(
      '[FEEDBACK_SCOPE_UNSUPPORTED] Scoped feedback requires an explicit tenant namespace; owner-only scope is not supported'
    );
  const key = createHash('sha256').update(scopeKey).digest('hex');
  return pathResolver.rootResolve(
    physicalScopedPath(
      'active/shared/runtime',
      canonical,
      'execution-feedback',
      canonical.tier,
      key
    )
  );
}
export function executionFeedbackCandidatePath(id: string, scope?: MemoryScopeEnvelope): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id))
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Invalid candidate id');
  return scope
    ? path.join(executionFeedbackScopeRoot(scope), 'candidates', id + '.json')
    : pathResolver.shared('runtime/distill-candidates/' + id + '.json');
}
function catalog(filePath: string) {
  return defineCatalog<DistillCandidateRecord>({
    id: 'execution-feedback-candidate',
    path: filePath,
    schema: pathResolver.knowledge('product/schemas/distill-candidate-record.schema.json'),
  });
}
export function loadExecutionFeedbackCandidate(
  id: string,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  const file = assertSafeRepositoryPath(executionFeedbackCandidatePath(id, scope), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(file)) return null;
  if (!safeLstat(file).isFile())
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Expected a regular candidate file');
  const row = scope ? catalog(file).load() : loadDistillCandidateRecord(id);
  if (
    !row ||
    row.metadata?.improvement_kind !== 'execution_feedback' ||
    executionFeedbackScopeKey(row.scope) !== executionFeedbackScopeKey(scope)
  )
    return null;
  return row;
}
export function listExecutionFeedbackCandidates(
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord[] {
  if (!scope)
    return listDistillCandidateRecords().filter(
      (row) => !row.scope && row.metadata?.improvement_kind === 'execution_feedback'
    );
  const dir = path.join(executionFeedbackScopeRoot(scope), 'candidates');
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadExecutionFeedbackCandidate(name.slice(0, -5), scope))
    .filter((row): row is DistillCandidateRecord => Boolean(row))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
export function saveExecutionFeedbackCandidate(row: DistillCandidateRecord): string {
  if (row.metadata?.improvement_kind !== 'execution_feedback')
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Expected execution feedback');
  const file = executionFeedbackCandidatePath(row.candidate_id, row.scope);
  if (!row.scope) return saveDistillCandidateRecord(row);
  if (row.tier !== row.scope.tier)
    throw new Error('[FEEDBACK_SCOPE_MISMATCH] Candidate tier differs from scope');
  const validated = catalog(file).validate(
    { ...row, scope: assertMemoryScope(row.scope), updated_at: nowIso() },
    file
  );
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(validated, null, 2));
  return file;
}
