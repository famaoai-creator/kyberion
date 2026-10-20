import { createHash } from 'node:crypto';
import type { ScopeContext } from '../scope-context.js';
import type { ScopedLearningPublicationIdentity } from './scoped-learning-publication.js';

/** Exact model-visible hint bytes, not a later read of its mutable source. */
export interface KnowledgeDeliverySnapshot {
  version: 1;
  text: string;
  sha256: string;
  form: 'pack' | 'system_prompt' | 'context_string' | 'needs_retry';
  context_pack_id?: string;
  /** Same-read source version, not a claim that the worker read the whole document. */
  source_sha256?: string;
  learning_publication?: ScopedLearningPublicationIdentity;
}

export function knowledgeTextSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createKnowledgeDeliverySnapshot(
  input: Omit<KnowledgeDeliverySnapshot, 'version' | 'sha256'>
): KnowledgeDeliverySnapshot {
  return { ...input, version: 1, sha256: knowledgeTextSha256(input.text) };
}

export function validKnowledgeDeliverySnapshot(
  value: KnowledgeDeliverySnapshot | undefined
): value is KnowledgeDeliverySnapshot {
  return (
    !!value &&
    value.version === 1 &&
    typeof value.text === 'string' &&
    value.sha256 === knowledgeTextSha256(value.text) &&
    (!value.source_sha256 || /^[a-f0-9]{64}$/.test(value.source_sha256)) &&
    (!value.learning_publication ||
      value.learning_publication.markdown_sha256 === value.source_sha256)
  );
}

/** Preserve every containment component, including public mission scopes. */
export function knowledgeAttributionScopeKey(scope?: ScopeContext): string {
  return JSON.stringify(
    scope
      ? [
          scope.tier,
          scope.tenant_slug || '',
          scope.organization_id || '',
          scope.project_id || '',
          scope.mission_id || '',
          scope.task_id || '',
          scope.session_id || '',
        ]
      : []
  );
}
