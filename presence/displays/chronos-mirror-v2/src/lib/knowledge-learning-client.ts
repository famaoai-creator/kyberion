import {
  parseKnowledgeCandidate,
  type ClientKnowledgeCandidate,
  type ClientKnowledgeCuration,
} from './knowledge-response';
import { workspaceQuery, workspaceSelectionFromQuery } from '@agent/core/surface/workspace-query';
import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';

export type LearningAction =
  'memory_curate_candidate' | 'memory_request_learning_approval' | 'memory_publish_learning';
export type LearningPending = {
  action: LearningAction;
  expectedPayloadDigest: string;
  curationDigest?: string;
};
export const LEARNING_PENDING_PREFIX = 'kyberion.learning.pending.v1.';
const actions = new Set([
  'memory_curate_candidate',
  'memory_request_learning_approval',
  'memory_publish_learning',
]);

export function parseLearningPending(raw: string | null): LearningPending | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery marker');
  const row = value as Record<string, unknown>;
  if (
    !actions.has(String(row.action)) ||
    typeof row.expectedPayloadDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.expectedPayloadDigest) ||
    Object.keys(row).some(
      (key) => !['action', 'expectedPayloadDigest', 'curationDigest'].includes(key)
    )
  )
    throw new Error('Invalid recovery marker');
  if (
    row.curationDigest !== undefined &&
    (typeof row.curationDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.curationDigest))
  )
    throw new Error('Invalid recovery digest');
  return {
    action: row.action as LearningAction,
    expectedPayloadDigest: row.expectedPayloadDigest,
    ...(typeof row.curationDigest === 'string' ? { curationDigest: row.curationDigest } : {}),
  };
}
/** A marker is only a recovery hint; canonical server state decides what happened. */
export async function curationRecoveryDigest(curation: ClientKnowledgeCuration): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      title: curation.title,
      summary: curation.summary,
      content: curation.content,
      evidence_refs: curation.evidence_refs,
    })
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function learningPendingResolved(
  marker: LearningPending,
  candidate: ClientKnowledgeCandidate
): Promise<boolean> {
  const learning = candidate.learning;
  if (!learning) return false;
  if (marker.action === 'memory_curate_candidate')
    return Boolean(
      (learning.payloadDigest && learning.payloadDigest !== marker.expectedPayloadDigest) ||
      (marker.curationDigest &&
        candidate.curation &&
        (await curationRecoveryDigest(candidate.curation)) === marker.curationDigest)
    );
  if (marker.action === 'memory_request_learning_approval') return Boolean(learning.approvalRef);
  return learning.state === 'published' && Boolean(learning.publication);
}
export function parseLearningMutationReceipt(
  value: unknown,
  expected: Pick<ClientKnowledgeCandidate, 'candidateKey' | 'candidate_id'>
): ClientKnowledgeCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true) return null;
  const candidate = parseKnowledgeCandidate(row.candidate);
  return candidate?.candidateKey === expected.candidateKey &&
    candidate.candidate_id === expected.candidate_id &&
    candidate.learning
    ? candidate
    : null;
}
export function learningMutationConfirmed(
  action: LearningAction,
  candidate: ClientKnowledgeCandidate,
  curation?: ClientKnowledgeCuration
): boolean {
  if (action === 'memory_curate_candidate')
    return (
      candidate.learning?.state === 'draft' &&
      Boolean(curation) &&
      JSON.stringify(candidate.curation) === JSON.stringify(curation)
    );
  if (action === 'memory_request_learning_approval')
    return Boolean(candidate.learning?.approvalRef);
  return candidate.learning?.state === 'published' && Boolean(candidate.learning.publication);
}
export function knowledgeCandidateHref(
  candidateKey: string,
  tenant?: string,
  selection: WorkspaceSelection = {}
): string {
  const params = workspaceQuery(selection);
  params.set('section', 'knowledge');
  params.set('candidateKey', candidateKey);
  if (tenant) params.set('tenant', tenant);
  return '/?' + params.toString();
}
export function learningReviewHref(
  approvalRef: string,
  candidateKey: string,
  tenant?: string,
  selection: WorkspaceSelection = {}
): string | null {
  const match = /^terminal:([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(approvalRef);
  if (!match) return null;
  const params = workspaceQuery(selection);
  params.set('section', 'approvals');
  params.set('request', match[1]);
  params.set('storageChannel', 'terminal');
  params.set('candidateKey', candidateKey);
  if (tenant) params.set('tenant', tenant);
  return '/?' + params.toString();
}
/** Defensive UI only. Unsupported restrictions are preserved, never stripped to gain support. */
export function learningScopeSupported(candidate: ClientKnowledgeCandidate): boolean {
  const scope = candidate.scope;
  return Boolean(
    scope &&
    scope.tier === 'confidential' &&
    scope.tenant_slug &&
    Object.entries(scope).every(
      ([key, value]) =>
        value === undefined ||
        ['tier', 'tenant_slug', 'organization_id', 'project_id'].includes(key)
    )
  );
}
export function approvalWorkspaceQuery(search: string, tenant?: string): URLSearchParams {
  const location = new URLSearchParams(search);
  const query = new URLSearchParams({ limit: '50' });
  for (const [key, value] of workspaceQuery(workspaceSelectionFromQuery(location)))
    query.set(key, value);
  const request = location.get('request');
  const storageChannel = location.get('storageChannel');
  if (request && storageChannel) {
    query.set('requestId', request);
    query.set('storageChannel', storageChannel);
  } else {
    // Existing mission-admission links have no storage channel. Preserve their
    // authorized mission history, then select a unique request locally.
    const missionId = location.get('mission');
    if (missionId) query.set('missionId', missionId);
    if (!request || !missionId) query.set('status', 'pending');
  }
  if (tenant) query.set('tenant', tenant);
  return query;
}
