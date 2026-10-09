/**
 * Activation status of a managed plugin record. Internal to
 * `plugin-managed-install.ts` — deliberately not re-exported from the plugin
 * barrel, so it is not part of the public API; tests import it directly.
 */
// Import the check from its own module (not approval-store) so this module
// stays outside the approval-store import cycle.
import { evaluateApprovalUsability } from '../governance/approval-separation-of-duties.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { createLogger } from '../logger.js';
import type { PluginTrustLabel } from './plugin-source-trust.js';

const logger = createLogger('plugin-activation-status');

export type PluginIntegrity = 'verified' | 'legacy' | 'mismatch';

export type PluginActivationStatus =
  'activatable' | 'pending_approval' | 'blocked_broken_manifest' | 'blocked_digest_mismatch';

export function resolveActivationStatus(params: {
  diagnostics: ReadonlyArray<{ severity: 'error' | 'warning' }>;
  trust: PluginTrustLabel;
  integrity: PluginIntegrity;
  approval?: ApprovalRequestRecord;
}): PluginActivationStatus {
  if (params.diagnostics.some((d) => d.severity === 'error')) return 'blocked_broken_manifest';
  if (params.integrity === 'mismatch') return 'blocked_digest_mismatch';
  // Official provenance needs no approval (its digest is recorded, not approved).
  if (params.trust === 'official') return 'activatable';
  // Legacy non-official records (no digest) must be re-installed and re-approved.
  if (params.integrity === 'legacy') return 'pending_approval';
  if (params.approval?.status !== 'approved') return 'pending_approval';
  // Separation of duties: an unusable approval does not activate. This runs
  // on every plugin load, so it evaluates without auditing each pass, and an
  // unreadable approval policy degrades to pending instead of throwing out of
  // plugin listing/loading.
  try {
    const refusal = evaluateApprovalUsability(params.approval, { consumer: 'plugin_activation' });
    return refusal ? 'pending_approval' : 'activatable';
  } catch (error) {
    logger.warn(
      `plugin approval not usable — ${error instanceof Error ? error.message : String(error)} | next: fix the approval policy, then reload plugins | evidence: approval ${params.approval.id}`
    );
    return 'pending_approval';
  }
}
