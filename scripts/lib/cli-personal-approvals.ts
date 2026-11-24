/**
 * The installed owner's personal approval partition for terminal decisions.
 *
 * Personal-scope requests (an `onboarding authority` activation, for one) are
 * stored under `personal/shared/owners/<owner hash>/`, which a plain CLI
 * process cannot see: that partition opens only inside an authenticated
 * personal-approval scope. `pnpm onboarding authority request` already
 * writes through that scope via the local authority principal; this module
 * gives `pnpm kyberion approvals` the same scope so the owner can list and
 * decide what they were asked to approve, without exporting
 * `KYBERION_TIER` / `KYBERION_NHI_ID` by hand.
 *
 * Opening the partition grants visibility only. The decision still has to
 * pass the terminal challenge (`approval-cli-decision.ts`): a human-only
 * request needs an interactive terminal outside any agent session (A2,
 * `terminal_attested`).
 *
 * Only channels whose consumer accepts a terminal decision are surfaced.
 * Other personal requests (`grant-standing` credential consent, for one) carry
 * an `owner` workflow role that the terminal decider (`sovereign`) does not
 * settle — approving them here would print "approved" and never take effect,
 * so they stay with Concierge. Listing prints the surfaced records' details to
 * the caller's stdout, the same exposure `pnpm onboarding authority status` has.
 *
 * Synchronous only: the execution context is an env mirror restored when the
 * callback returns, so callbacks must not return a promise.
 */
import { withAuthenticatedPersonalApprovals } from '@agent/core/governance/authenticated-personal-approvals';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { createLogger } from '@agent/core/logger';
import { ONBOARDING_AUTHORITY_CHANNEL } from '@agent/core/organization/onboarding-authority';
import { withLocalAuthorityPrincipal } from './authority-principal.js';
import { inspectInstalledIdentity } from './installed-identity.js';

const logger = createLogger('cli-personal-approvals');

/** Personal channels decided at the terminal; each needs a consumer test. */
export const CLI_PERSONAL_APPROVAL_CHANNELS: ReadonlySet<string> = new Set([
  ONBOARDING_AUTHORITY_CHANNEL,
]);

/** Runs `run` (sync) inside the owner's personal approval scope; null when unavailable. */
export function withCliPersonalApprovals<T>(run: () => T): { value: T } | null {
  // An installation-backed or unidentified checkout decides at its canonical
  // root (`onboarding authority` prints the command); a checkout that has not
  // completed identity onboarding has no personal approvals. Both stay closed.
  const installed = inspectInstalledIdentity();
  if (installed.source !== 'local' || !installed.ready) return null;
  let failed: { error: unknown } | undefined;
  let opened: { value: T } | null;
  try {
    opened = withLocalAuthorityPrincipal([], (principal) =>
      withAuthenticatedPersonalApprovals(principal, () => {
        try {
          return { value: run() };
        } catch (error) {
          failed = { error };
          throw error;
        }
      })
    );
  } catch (error) {
    // Failures of `run` itself are the caller's; only an unavailable scope closes the partition.
    if (failed) throw failed.error;
    logger.warn(
      `personal approvals not listed — the owner's personal approval scope could not be opened | next: pnpm onboarding check --json | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  // A null scope (personal runtime not installed / not activated) is routine
  // while onboarding is unfinished; the decision path reports it explicitly.
  if (!opened)
    logger.debug(
      'personal approvals not listed — the installed personal runtime is not ready for this owner'
    );
  return opened;
}

/** A record kept in the owner's personal partition (tier personal, no tenant). */
export function isPersonalPartitionApproval(record: ApprovalRequestRecord): boolean {
  return record.scope?.tier === 'personal' && !record.scope.tenant_slug;
}

/** A personal-partition record on a channel the terminal may decide. */
export function isCliDecidablePersonalApproval(record: ApprovalRequestRecord): boolean {
  return (
    isPersonalPartitionApproval(record) &&
    CLI_PERSONAL_APPROVAL_CHANNELS.has(record.storageChannel ?? record.channel)
  );
}

/** Store scope for one decision on `record`: the personal scope for terminal-decidable personal records. */
export function cliApprovalStoreScope(
  record: ApprovalRequestRecord
): (<T>(run: () => T) => T) | undefined {
  if (!isCliDecidablePersonalApproval(record)) return undefined;
  return <T>(run: () => T): T => {
    const result = withCliPersonalApprovals(run);
    if (!result)
      throw new Error(
        `[POLICY_VIOLATION] request ${record.id} is in the installed owner's personal approvals, which this checkout cannot open | next: complete identity onboarding (pnpm onboarding check --json), or decide it in a signed-in Concierge session | evidence: scope tier personal, no tenant`
      );
    return result.value;
  };
}

/**
 * Pending requests this terminal may decide: the ordinary store, plus the
 * owner's terminal-decidable personal records when the partition opens.
 * Personal records are appended only once.
 */
export function listCliPendingApprovals(
  list: () => ApprovalRequestRecord[]
): ApprovalRequestRecord[] {
  // A personal record the terminal cannot settle stays out even when an
  // explicit personal env put it in the ordinary listing.
  const ordinary = list().filter(
    (record) => !isPersonalPartitionApproval(record) || isCliDecidablePersonalApproval(record)
  );
  const seen = new Set(ordinary.map((record) => `${record.storageChannel}/${record.id}`));
  const personal = (withCliPersonalApprovals(list)?.value ?? []).filter(
    (record) =>
      isCliDecidablePersonalApproval(record) && !seen.has(`${record.storageChannel}/${record.id}`)
  );
  return [...ordinary, ...personal];
}
