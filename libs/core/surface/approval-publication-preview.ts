/**
 * Reads the PR a `vcs:pr_create` approval would open, for its decision brief.
 *
 * The request's summary names a content-addressed review artifact
 * (`…/pr-publication/<run>/<sha256>.json`, written by
 * `runVcsMutationWithApproval`). The preview is used only when the file sits in
 * the request's own tenant floor AND its content hashes to the name the
 * summary carries — so what the card shows is bound by the same presented
 * digest that binds the decision. Anything else (missing, unreadable, hash
 * mismatch) falls back to the generic sentence.
 */

import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile } from '../secure-io.js';
import {
  parsePublicationPreview,
  publicationArtifactRef,
  type DecisionBriefSubject,
  type PublicationPreview,
} from './decision-brief.js';

const MAX_PREVIEW_MB = 1;

export function readApprovalPublicationPreview(
  record: Pick<DecisionBriefSubject, 'summary' | 'scope'>
): PublicationPreview | undefined {
  const ref = publicationArtifactRef(record);
  if (!ref) return undefined;
  try {
    const raw = safeReadFile(pathResolver.rootResolve(ref.path), {
      maxSizeMB: MAX_PREVIEW_MB,
      label: 'pr publication review',
    });
    const parsed: unknown = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (computeApprovalPayloadHash(parsed as Record<string, unknown>) !== ref.contentHash)
      return undefined;
    return parsePublicationPreview(parsed);
  } catch {
    // Display enrichment only: the card falls back to the generic sentence.
    return undefined;
  }
}
