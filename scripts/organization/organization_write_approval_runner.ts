/**
 * The approval-mediated organization write path, kept out of the facade
 * (organization_operating_model.ts) so the facade stays a dispatcher.
 */
import { withExecutionContext } from '@agent/core/authority';
import { baseRoleEnvText } from '@agent/core/foundation';
import { validateWritePermission } from '@agent/core/tier-guard';
import type { ParsedArgs } from './organization_operating_model_args.js';
import {
  ORGANIZATION_WRITE_ROLE,
  requestOrganizationWriteApproval,
  runWithOrganizationWriteApproval,
  verifyOrganizationWriteApproval,
} from './organization_write_approval.js';

/**
 * The approval-mediated write path (organization_write_approval.ts). Returns
 * true when it handled the invocation (request opened, or the approved write
 * ran); false for every ordinary invocation, which continues unchanged.
 * Only an `--apply` write the caller may not perform takes this path; decision
 * transitions keep their own approval flow.
 */
export function runApprovedOrganizationWrite<
  Ctx extends { activePrint: (value: unknown) => void },
  Scope extends { tier?: string; tenantSlug?: string } = { tier?: string; tenantSlug?: string },
>(
  parsed: ParsedArgs,
  organizationId: string | undefined,
  readScope: Scope,
  print: (value: unknown) => void,
  deps: {
    /** The organization state file this invocation writes (the facade preflight target). */
    writeTarget: string | undefined;
    handlers: Record<string, ((ctx: Ctx) => void) | undefined>;
    usage: () => string;
  }
): boolean {
  const writePreflightTarget = deps.writeTarget;
  const wantsApproval = parsed.approvalRequestId || parsed.requestApproval;
  if (!parsed.apply || !wantsApproval || parsed.command === 'decision transition') return false;
  if (!writePreflightTarget || !organizationId) return false;
  if (validateWritePermission(writePreflightTarget).allowed) {
    const flag = parsed.approvalRequestId ? '--approval-request-id' : '--request-approval';
    throw new Error(
      `[ORGANIZATION_WRITE_APPROVAL_NOT_NEEDED] ${parsed.command} not run — this caller can already write this organization, so ${flag} is refused rather than ignored ` +
        `| next: run the command without ${flag}${parsed.approvalRequestId ? ' (the approval stays unused)' : ''} ` +
        `| evidence: write target ${writePreflightTarget}; nothing was written`
    );
  }
  const tier = parsed.tier || readScope.tier;
  // The handlers write with --tenant-slug only: the approval must name that same
  // tenant, never one taken from the current scope selection.
  const tenantSlug = parsed.tenantSlug;
  if (!tier || !tenantSlug) {
    throw new Error(
      `[ORGANIZATION_WRITE_APPROVAL_SCOPE] ${parsed.command} not run — an approval-mediated organization write needs an explicit --tenant-slug (the current scope selection is not used) ` +
        '| next: add --tenant-slug <tenant>; a shared-scope organization (no tenant) still needs KYBERION_BASE_ROLE=sovereign ' +
        `| evidence: organization ${organizationId}, tier ${tier ?? '(none)'}; nothing was written`
    );
  }
  const scope = { command: parsed.command, organizationId, tier, tenantSlug };
  const fields = parsed as unknown as Record<string, unknown>;
  if (!parsed.approvalRequestId) {
    const { request_id } = requestOrganizationWriteApproval({
      scope,
      parsed: fields,
      callerRole: baseRoleEnvText() || 'unknown',
    });
    print(
      [
        `Approval requested: ${request_id} — nothing was written.`,
        `A human approves it with: pnpm kyberion approvals --approve ${request_id}`,
        `  (from an agent CLI such as Claude Code: pnpm kyberion approvals --approve ${request_id} --new-window)`,
        `Then re-run this exact command with --approval-request-id ${request_id} instead of --request-approval.`,
      ].join('\n')
    );
    return true;
  }
  const handler = deps.handlers[parsed.command];
  if (!handler) throw new Error(`Unknown command '${parsed.command}'.\n${deps.usage()}`);
  // An argument mistake must not burn the approval: verify it, then run the same
  // command as a dry run (nothing written) before the approval is used.
  verifyOrganizationWriteApproval(parsed.approvalRequestId, scope, fields);
  try {
    withExecutionContext(
      ORGANIZATION_WRITE_ROLE,
      () =>
        handler({
          parsed: { ...parsed, apply: false, dryRun: true },
          organizationId,
          readScope,
          activePrint: () => undefined,
        } as unknown as Ctx),
      undefined,
      tenantSlug,
      organizationId
    );
  } catch (error) {
    throw new Error(
      `[ORGANIZATION_WRITE_DRY_RUN_FAILED] ${parsed.command} not run — the dry run before using approval ${parsed.approvalRequestId} failed: ${error instanceof Error ? error.message : String(error)} ` +
        '| next: the approval is still unused, but it is bound to these exact arguments; open a new request with corrected arguments (--request-approval) ' +
        '| evidence: nothing was written, the approval was not consumed'
    );
  }
  // Verified again and marked used (inside the approval's record lock); then only
  // this one write runs with the role, bound to the organization's tenant.
  runWithOrganizationWriteApproval(
    parsed.approvalRequestId,
    scope,
    fields,
    `pnpm organization ${parsed.command}`,
    () =>
      withExecutionContext(
        ORGANIZATION_WRITE_ROLE,
        () => handler({ parsed, organizationId, readScope, activePrint: print } as unknown as Ctx),
        undefined,
        tenantSlug,
        organizationId
      )
  );
  print(`Approval ${parsed.approvalRequestId} used for this write; it cannot authorize another.`);
  return true;
}
