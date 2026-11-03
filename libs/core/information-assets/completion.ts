import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { InformationAssetReadback, InformationAssetWorkBinding } from './work-types.js';
export function informationArtifactHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
export function verifyInformationAssetReadback(
  binding: InformationAssetWorkBinding,
  evidence: InformationAssetReadback
): boolean {
  return (
    evidence.verified === true &&
    isDeepStrictEqual(evidence.scope, binding.observation.scope) &&
    evidence.subject_id === binding.observation.subject_id &&
    evidence.change_id === binding.observation.change_id &&
    /^[a-f0-9]{64}$/.test(evidence.evidence_sha256)
  );
}
