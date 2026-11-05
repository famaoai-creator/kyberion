/**
 * Canonical form of an approval principal id — a leaf module so stores that
 * compare a recorded decider with a principal (e.g. the person-custody
 * attestation store) do not load the approval machinery. Re-exported by
 * `approval-separation-of-duties.ts`.
 */

/**
 * Principal-type prefixes surfaces put in front of an identity
 * (`user:<member_id>` from chronos / presence-studio, `agent:…`, `service:…`).
 * They are stripped before comparison so `user:alice` and `alice` count as the
 * same principal. Because the requester controls `requestedBy`, a requester
 * can also make a later decider look like themselves (false positive); that
 * only refuses a decision, which is the safe direction.
 */
const APPROVAL_PRINCIPAL_PREFIX =
  /^(?:user|human|operator|member|principal|agent|service|persona|actor|policy):/;

/** Canonical form of an approval principal id for identity comparison. */
export function normalizeApprovalPrincipalId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().toLowerCase().replace(APPROVAL_PRINCIPAL_PREFIX, '').trim();
}
