/**
 * Approval-mediated organization writes (MSN-APPROVAL-UX-20261122).
 *
 * A caller without organization write authority (e.g. an agent session: no
 * KYBERION_BASE_ROLE=sovereign, no MISSION_ROLE=organization_operator) can ask
 * a human to approve one exact write instead of being given the role:
 *
 *   1. `pnpm organization <write> ... --apply --request-approval` opens a
 *      human-only approval bound to that exact command and arguments
 *      (payload hash) and to the organization scope; nothing is written.
 *   2. A human approves: `pnpm kyberion approvals --approve <id>` (in an
 *      agent CLI add `--new-window`). A terminal attestation (A2) is accepted
 *      — the operator decided (2026-11-22) that passkey-only is too hard for
 *      installations without outside access. Stronger methods are accepted too.
 *   3. The same command with `--approval-request-id <id>` instead of
 *      `--request-approval` verifies the approval against the recomputed
 *      payload, uses it up once, and runs only that write as
 *      `organization_operator` bound to the organization's tenant.
 *
 * Organization decisions keep their own, stronger flow
 * (`organization_decision_approval.ts`: surface session / TOTP / passkey).
 */
import {
  assertApprovalUsable,
  computeApprovalPayloadHash,
  createApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import { consumeApprovalWithin } from '@agent/core/governance/approval-revocation';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
} from '@agent/core/governance/approval-requester';

/** Storage channel for organization write approvals (same as decisions). */
export const ORGANIZATION_WRITE_APPROVAL_CHANNEL = 'terminal';
/** The role a verified approval runs its one write as (bound to the tenant). */
export const ORGANIZATION_WRITE_ROLE = 'organization_operator';
const CONSUMER = 'organization_write';

/** Approval methods a write accepts: a person proved at a terminal (A2) or stronger. */
const ACCEPTED_AUTH_METHODS = ['terminal_attested', 'surface_session', 'totp', 'passkey'] as const;

/** Parsed fields that steer the approval flow itself, never part of what is approved. */
const FLOW_FIELDS = new Set([
  'requestApproval',
  'approvalRequestId',
  'apply',
  'dryRun',
  'unknownFlags',
  'json',
]);

export interface OrganizationWriteScope {
  command: string;
  organizationId: string;
  tier: string;
  tenantSlug: string;
}

function effectBinding(scope: OrganizationWriteScope): string {
  return `organization:write:${scope.tenantSlug}:${scope.organizationId}:${scope.command}`;
}

/** The write's arguments as approved: every parsed field except the flow flags, empty values dropped. */
export function canonicalWriteArgs(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(parsed).sort()) {
    if (FLOW_FIELDS.has(key)) continue;
    const value = parsed[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function organizationWritePayloadHash(
  scope: OrganizationWriteScope,
  parsed: Record<string, unknown>
): string {
  return computeApprovalPayloadHash({
    command: scope.command,
    organization_id: scope.organizationId,
    tier: scope.tier,
    tenant_slug: scope.tenantSlug,
    args: canonicalWriteArgs(parsed),
  });
}

/** Opens the human-only request for one exact organization write. */
export function requestOrganizationWriteApproval(input: {
  scope: OrganizationWriteScope;
  parsed: Record<string, unknown>;
  requester?: ApprovalRequesterInput;
  /** The caller's own role (it lacks write authority; the write later runs as organization_operator). */
  callerRole?: string;
}): { request_id: string; effect: string } {
  const { scope } = input;
  const effect = effectBinding(scope);
  const requester = resolveApprovalRequesterInput(
    input.requester ?? resolveCliApprovalRequester({ legacy: 'organization-cli' })
  );
  const args = canonicalWriteArgs(input.parsed);
  const record = createApprovalRequest('mission_controller', {
    channel: ORGANIZATION_WRITE_APPROVAL_CHANNEL,
    threadTs: `organization-write-${scope.organizationId}-${Date.now()}`,
    correlationId: `organization:${scope.tenantSlug}:${scope.organizationId}:write:${scope.command}`,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    kind: 'mission_gate',
    draft: {
      title: `Organization write: ${scope.command} (${scope.organizationId})`,
      summary: `Allow one 'pnpm organization ${scope.command}' write to ${scope.organizationId} in tenant ${scope.tenantSlug} (${scope.tier}).`,
      details: [
        `Command: pnpm organization ${scope.command}`,
        `Organization: ${scope.organizationId} · tenant ${scope.tenantSlug} · tier ${scope.tier}`,
        `Arguments: ${JSON.stringify(args)}`,
        `Runs once as ${ORGANIZATION_WRITE_ROLE}, then the approval is used up.`,
      ].join('\n'),
      severity: 'medium',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: input.callerRole || 'unknown',
    },
    justification: {
      reason: `The caller has no organization write authority; a human approves this one write.`,
      impactSummary: `Writes the organization operating model of ${scope.organizationId} (${scope.command}).`,
      requestedEffects: [effect],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: organizationWritePayloadHash(scope, input.parsed),
      effectBinding: effect,
    },
    scope: {
      tier: scope.tier,
      tenant_slug: scope.tenantSlug,
      organization_id: scope.organizationId,
    },
  } as Parameters<typeof createApprovalRequest>[1]);
  return { request_id: record.id, effect };
}

/**
 * Verifies that `requestId` is an approved, human-only, unused approval for
 * exactly this write (same command, arguments and scope). Throws otherwise.
 */
export function verifyOrganizationWriteApproval(
  requestId: string,
  scope: OrganizationWriteScope,
  parsed: Record<string, unknown>
): void {
  const approval = loadApprovalRequest(ORGANIZATION_WRITE_APPROVAL_CHANNEL, requestId);
  const authMethod = (approval?.decidedAuthMethod || '') as (typeof ACCEPTED_AUTH_METHODS)[number];
  const problems: string[] = [];
  if (!approval) problems.push('no such approval request');
  else {
    if (approval.status !== 'approved') problems.push(`status is ${approval.status}`);
    if (approval.decidedByType !== 'human' || approval.authenticated !== true)
      problems.push('not decided by an authenticated human');
    if (!ACCEPTED_AUTH_METHODS.includes(authMethod))
      problems.push(
        `auth method '${approval.decidedAuthMethod || '(none)'}' is below terminal attestation`
      );
    if (approval.accountability?.finalDecision !== 'human_only')
      problems.push('not a human-only request');
    if (approval.accountability?.effectBinding !== effectBinding(scope))
      problems.push('approved for a different organization write');
    if (
      approval.scope?.organization_id !== scope.organizationId ||
      approval.scope?.tenant_slug !== scope.tenantSlug ||
      approval.scope?.tier !== scope.tier
    )
      problems.push('approved for a different organization scope');
    if (approval.accountability?.payloadHash !== organizationWritePayloadHash(scope, parsed))
      problems.push('the command arguments differ from the approved ones');
  }
  if (problems.length) {
    throw new Error(
      `[ORGANIZATION_WRITE_APPROVAL_INVALID] approval ${requestId} does not allow this write — ${problems.join('; ')} ` +
        '| next: re-run the exact approved command, or open a new request with --request-approval ' +
        `| evidence: channel ${ORGANIZATION_WRITE_APPROVAL_CHANNEL}, effect ${effectBinding(scope)}`
    );
  }
  assertApprovalUsable(approval!, { consumer: CONSUMER });
}

/**
 * Runs `write` under one approval, at most once ever. Inside the approval's
 * record lock: verify it for exactly this write, mark it used, then write.
 * Marking comes first, so a second run with the same id is refused before
 * any write (a used approval cannot write twice), and a write that fails
 * leaves the approval used rather than reusable.
 */
export function runWithOrganizationWriteApproval<T>(
  requestId: string,
  scope: OrganizationWriteScope,
  parsed: Record<string, unknown>,
  consumedBy: string,
  write: () => T
): T {
  return consumeApprovalWithin(
    'mission_controller',
    { channel: ORGANIZATION_WRITE_APPROVAL_CHANNEL, requestId, consumer: CONSUMER, consumedBy },
    (consume) => {
      verifyOrganizationWriteApproval(requestId, scope, parsed);
      consume();
      return write();
    }
  );
}
