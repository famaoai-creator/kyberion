import * as path from 'node:path';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import type { ScopeContext } from '../scope-context.js';
import { loadMemoryPromotionCandidate } from './memory-promotion-queue.js';
import {
  assertScopedLearningScope,
  verifyScopedLearningPublication,
  type ScopedLearningPublicationIdentity,
} from './scoped-learning-publication.js';
import { memoryScopeAllowsRead, type MemoryScopeEnvelope } from './memory-scope.js';

/** An indexed excerpt is usable only when its SAME-read bytes match publication. */
export function resolveScopedLearningRetrieval(input: {
  documentPath: string;
  sourceSha256?: string;
  candidateId?: string;
  scopeText?: string;
  consumerScope?: ScopeContext;
}): { governed: boolean; publication?: ScopedLearningPublicationIdentity } {
  const documentPath = path.posix.normalize(input.documentPath.replaceAll('\\', '/'));
  // Canonical namespace decides this lane, never mutable frontmatter or ID spelling.
  const governed =
    /^knowledge\/confidential\/[^/]+\/(?:organizations\/[^/]+\/)?(?:projects\/[^/]+\/)?evolution\/operations\/[^/]+\.md$/.test(
      documentPath
    );
  if (!governed) return { governed: false };
  try {
    if (!input.candidateId || !input.scopeText || !input.consumerScope || !input.sourceSha256)
      return { governed: true };
    const scope = assertScopedLearningScope(
      parseSafeJsonInput(input.scopeText, 'learning source scope') as MemoryScopeEnvelope
    );
    if (!memoryScopeAllowsRead(scope, input.consumerScope)) return { governed: true };
    const candidate = loadMemoryPromotionCandidate(input.candidateId, scope);
    const publication = candidate ? verifyScopedLearningPublication(candidate) : undefined;
    if (
      !publication ||
      publication.markdown_path !== documentPath ||
      publication.markdown_sha256 !== input.sourceSha256
    )
      return { governed: true };
    return { governed: true, publication };
  } catch {
    return { governed: true };
  }
}
