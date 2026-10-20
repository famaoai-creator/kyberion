/** Pure exact-scope SOP publication interfaces. Learning never conveys authority. */
import type { MemoryScopeEnvelope } from './memory-scope.js';
import type { HumanDecidedBy } from '../mission/mission-types.js';

export interface ScopedLearningApproval {
  version: 1;
  payload_digest: string;
  approval_ref: string;
  decided_by: HumanDecidedBy;
  approved_at: string;
  channel: 'steward';
}
export interface ScopedLearningPublicationIdentity {
  version: 1;
  candidate_id: string;
  scope: MemoryScopeEnvelope;
  approved_payload_digest: string;
  record_path: string;
  markdown_path: string;
  record_sha256: string;
  markdown_sha256: string;
}
