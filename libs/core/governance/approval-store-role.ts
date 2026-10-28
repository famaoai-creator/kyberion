import type { GovernedArtifactRole } from '../workforce/artifact-store.js';

/**
 * Approval records have a dedicated local-admin writer already authorized by
 * security-policy. This type does not add it to generic artifact writers or
 * data-driven surface role mappings; every write still checks that identity's
 * existing channel and tenant permissions.
 */
export type ApprovalStoreRole = GovernedArtifactRole | 'chronos_localadmin';
