/** Immutable link from a reuse proposal to the existing memory review queue. */
import { createHash } from 'node:crypto';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  loadDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { assertSafeRepositoryPath, safeReadFileSnapshot } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const PREFIX = 'artifact:learning_intake:';
const SHA256 = /^[a-f0-9]{64}$/u;

export function learningEntityRoot(scope: MemoryScopeEnvelope): string {
  if (scope.tier === 'personal') {
    if (!scope.owner_nhi)
      throw new Error('[LEARNING_SOURCE_SCOPE] Personal learning requires owner_nhi');
    return `knowledge/personal/owners/${digest(scope.owner_nhi).slice(0, 20)}`;
  }
  let root = `knowledge/confidential/${scope.tenant_slug}`;
  for (const [directory, field] of [
    ['organizations', 'organization_id'],
    ['projects', 'project_id'],
    ['missions', 'mission_id'],
    ['tasks', 'task_id'],
    ['sessions', 'session_id'],
  ] as const) {
    if (!scope[field]) break;
    root += `/${directory}/${scope[field]}`;
  }
  return root;
}

export function learningSourceAllowed(ref: string, scope: MemoryScopeEnvelope): boolean {
  if (ref.startsWith('/') || ref.includes('\\') || ref.split('/').includes('..')) return false;
  if (/^(?:knowledge\/(?:product|public)\/|pipelines\/|plugins\/)/u.test(ref)) return true;
  if (scope.tier !== 'public') {
    const root = learningEntityRoot(scope);
    if (ref.startsWith(root + '/'))
      return !ref
        .slice(root.length + 1)
        .split('/')
        .some((part) =>
          ['organizations', 'projects', 'missions', 'tasks', 'sessions'].includes(part)
        );
    if (
      scope.tier === 'personal' &&
      scope.owner_nhi &&
      ref.startsWith(`active/personal/owners/${digest(scope.owner_nhi)}/`)
    )
      return true;
  }
  if (scope.mission_id && scope.tier !== 'personal') {
    const partition = scope.tier === 'confidential' ? `${scope.tenant_slug}/` : '';
    if (ref.startsWith(`active/missions/${scope.tier}/${partition}${scope.mission_id}/evidence/`))
      return true;
  }
  if (!scope.organization_id && !scope.project_id && !scope.mission_id) {
    if (scope.tier === 'public')
      return /^active\/shared\/(?:tmp|staging)\/public\/shared\//u.test(ref);
    if (scope.tier === 'confidential')
      return ['tmp', 'staging'].some((floor) =>
        ref.startsWith(`active/shared/${floor}/confidential/${scope.tenant_slug}/`)
      );
  }
  return false;
}

export function reusableLearningBindingDigest(record: DistillCandidateRecord): string {
  const plan = record.metadata?.learning_plan as Record<string, unknown> | undefined;
  if (record.metadata?.origin !== 'learning_intake' || !plan || plan.version !== 1)
    throw new Error('[LEARNING_LINK_INVALID] Expected a persisted learning intake plan');
  // Exclude maintenance/link timestamps, but bind every planning decision and source.
  return digest(
    JSON.stringify({
      candidate_id: record.candidate_id,
      title: record.title,
      summary: record.summary,
      scope: plan.scope,
      decision: plan.decision,
      destination: plan.destination,
      source_ref: plan.source_ref,
      source_sha256: plan.source_sha256,
      target_ref: plan.target_ref,
      base_sha256: plan.base_sha256,
      reuse_condition: plan.reuse_condition,
      verification_command: plan.verification_command,
    })
  );
}

export function reusableLearningMemorySourceRef(record: DistillCandidateRecord): string {
  return `${PREFIX}${record.candidate_id}:${reusableLearningBindingDigest(record)}`;
}

function verifyFile(ref: unknown, hash: unknown): void {
  if (typeof ref !== 'string' || typeof hash !== 'string' || !SHA256.test(hash))
    throw new Error('[LEARNING_LINK_INVALID] Missing source/target digest');
  const file = assertSafeRepositoryPath(pathResolver.rootResolve(ref));
  const bytes = safeReadFileSnapshot(file, 128 * 1024 + 1);
  if (bytes.length > 128 * 1024 || digest(bytes.toString('utf8')) !== hash)
    throw new Error(
      '[LEARNING_LINK_STALE] Source or target changed; prepare and review a new plan'
    );
}

/** Called again by review and publication; queued intent never freezes mutable evidence. */
export function assertReusableLearningBinding(candidate: {
  source_ref: string;
  scope?: MemoryScopeEnvelope;
}): DistillCandidateRecord | undefined {
  if (!candidate.source_ref.startsWith(PREFIX)) return undefined;
  const match = candidate.source_ref
    .slice(PREFIX.length)
    .match(/^([A-Za-z0-9._-]+):([a-f0-9]{64})$/u);
  if (!match) throw new Error('[LEARNING_LINK_INVALID] Malformed learning intake binding');
  const record = loadDistillCandidateRecord(match[1], candidate.scope);
  if (!record || reusableLearningBindingDigest(record) !== match[2])
    throw new Error('[LEARNING_LINK_STALE] Persisted learning proposal changed or disappeared');
  const plan = record.metadata!.learning_plan as {
    scope: MemoryScopeEnvelope;
    source_ref: string;
    source_sha256: string;
    target_ref?: string;
    base_sha256?: string;
  };
  const scope = assertMemoryScope(plan.scope);
  if (
    record.tier !== scope.tier ||
    (record.scope
      ? JSON.stringify(assertMemoryScope(record.scope)) !== JSON.stringify(scope)
      : scope.tier !== 'public' || Boolean(scope.tenant_slug || scope.owner_nhi))
  )
    throw new Error('[LEARNING_LINK_INVALID] Plan scope does not match its persisted record');
  if (
    !learningSourceAllowed(plan.source_ref, scope) ||
    (plan.target_ref &&
      (!learningSourceAllowed(plan.target_ref, scope) ||
        (scope.tier !== 'public' && !plan.target_ref.startsWith(learningEntityRoot(scope) + '/'))))
  )
    throw new Error('[LEARNING_LINK_INVALID] Source or target is outside the plan scope');
  verifyFile(plan.source_ref, plan.source_sha256);
  if (plan.target_ref || plan.base_sha256) verifyFile(plan.target_ref, plan.base_sha256);
  return record;
}
