/**
 * Terminal approval decisions (`pnpm kyberion approvals --approve/--deny/--revoke`,
 * `pnpm kyberion approve|reject`, `service_recording review`). The terminal
 * decides as the local owner member (`user:<member_id>`, see
 * `cli-operator-principal.ts`) with the onboarding display name recorded
 * beside it.
 *
 * Separation of duties on: an approval needs an interactive terminal and a
 * typed challenge (a short code printed with the request summary). There is no
 * flag to skip it, and without a TTY the approval is refused with a pointer to
 * the authenticated surfaces.
 *
 * The challenge waits `CLI_TTY_CHALLENGE_TIMEOUT_MS` (120s) for the code and
 * then refuses, closing the reader.
 *
 * Trust: this is best effort. Anything that gives an agent a pseudo-terminal
 * can read the code and type it: terminal-actuator, but equally `script`,
 * `expect`, `unbuffer` or a shell coproc. Agent-session markers are advisory
 * environment variables an agent can clear. The challenge stops an agent
 * running the command non-interactively; it does not authenticate a person. A
 * separated approval that must hold against an agent belongs on an
 * authenticated surface (Chronos or presence-studio).
 *
 * Separation of duties off: no challenge (unchanged). A decision typed inside
 * an agent session is still recorded as the owner, but marked
 * `caller_supplied` with the agent principal, so it can never pass a later
 * separation-of-duties re-check.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  decideApprovalRequest,
  isSeparationOfDutiesEnabled,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { refuseHumanOnlyDecisionOnAgentPath } from '@agent/core/governance';
import {
  revokeApprovalAsLocalOwner,
  revokeApprovalRequest,
} from '@agent/core/governance/approval-revocation';
import {
  detectCliAgentPrincipal,
  resolveCliApprovalDecider,
  resolveCliOperatorIdentity,
  type CliOperatorPrincipalOptions,
} from '@agent/core/governance/cli-operator-principal';

import {
  CLI_TTY_CHALLENGE_TIMEOUT_MS,
  resolveCliTtyChallengeTerminal,
  type CliTtyIo,
} from './cli-tty-io.js';

/** One typed line, or `null` when nothing arrives within `timeoutMs`. */
function readOneLine(stdin: NodeJS.ReadableStream, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    rl.once('line', (line) => settle(line));
    rl.once('close', () => settle(''));
  });
}

/**
 * Best-effort confirmation that a person at an interactive terminal approves:
 * refuses without a TTY, else prints the request and a one-time code and
 * proceeds only when the typed answer matches.
 */
async function confirmApprovalByTtyChallenge(
  request: ApprovalRequestRecord,
  io: CliTtyIo,
  timeoutMs: number
): Promise<void> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new Error(
      '[POLICY_VIOLATION] approval decision blocked — separation of duties is on and this terminal is not interactive, ' +
        'so the approval cannot be confirmed at the keyboard ' +
        '| next: approve it on an authenticated surface (Chronos or presence-studio), or run the command in an interactive terminal and answer its challenge ' +
        `| evidence: stdin.isTTY=${Boolean(io.stdin.isTTY)} stdout.isTTY=${Boolean(io.stdout.isTTY)}, request ${request.id}`
    );
  }
  const code = randomBytes(3).toString('hex');
  io.stdout.write(
    [
      '',
      `Approve ${request.id}: ${request.title}`,
      `  ${request.summary}`,
      `  requested by ${request.requestedBy}${request.requestedByContext?.actorId && request.requestedByContext.actorId !== request.requestedBy ? ` (via ${request.requestedByContext.actorId})` : ''}`,
      `Type ${code} to approve (anything else cancels): `,
    ].join('\n')
  );
  const typed = await readOneLine(io.stdin, timeoutMs);
  if (typed === null) {
    io.stdout.write('\n');
    throw new Error(
      '[POLICY_VIOLATION] challenge timed out — no code was typed within ' +
        `${Math.round(timeoutMs / 1000)}s, so the approval was not recorded ` +
        '| next: re-run the command and type the code it prints, or approve on Chronos or presence-studio ' +
        `| evidence: request ${request.id}, timeout ${timeoutMs}ms (default ${CLI_TTY_CHALLENGE_TIMEOUT_MS}ms)`
    );
  }
  const answer = typed.trim();
  if (answer !== code) {
    throw new Error(
      '[POLICY_VIOLATION] approval decision cancelled — the typed challenge did not match ' +
        '| next: re-run the command and type the code it prints ' +
        `| evidence: request ${request.id}`
    );
  }
}

export async function decideApprovalFromCli(
  request: ApprovalRequestRecord,
  params: CliOperatorPrincipalOptions & {
    decision: 'approved' | 'rejected';
    note: string;
  }
): Promise<ApprovalRequestRecord> {
  const decider = resolveCliApprovalDecider({ ...params, decision: params.decision });
  if (decider.decidedInAgentSession) {
    refuseHumanOnlyDecisionOnAgentPath(request, 'the terminal inside an agent session');
  }
  const challenged = params.decision === 'approved' && isSeparationOfDutiesEnabled();
  if (challenged) {
    const terminal = resolveCliTtyChallengeTerminal();
    await confirmApprovalByTtyChallenge(request, terminal.io, terminal.timeoutMs);
  }
  const decided = decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: params.decision,
    decidedBy: decider.decidedBy,
    decidedByDisplayName: decider.decidedByDisplayName,
    ...(decider.deciderIdentitySource
      ? { deciderIdentitySource: decider.deciderIdentitySource }
      : {}),
    ...(decider.decidedInAgentSession
      ? { decidedInAgentSession: decider.decidedInAgentSession }
      : {}),
    ...(challenged ? { decidedVia: 'cli_tty_challenge' as const } : {}),
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
    note: params.note,
  });
  if (decider.decidedInAgentSession) {
    auditChain.record({
      agentId: decider.decidedInAgentSession,
      action: 'approval_decision',
      operation: 'cli_decision_in_agent_session',
      result: 'completed',
      reason:
        'terminal decision typed inside an agent session; recorded as caller_supplied, so separation of duties will refuse it',
      correlationId: decided.correlationId,
      metadata: { requestId: decided.id, decision: params.decision, decidedBy: decider.decidedBy },
    });
  }
  return decided;
}

/** Approved records the terminal may try to revoke (the store refuses used ones). */
export function findRevocableApproval(
  requestId: string,
  storageChannels?: string[]
): ApprovalRequestRecord | undefined {
  return listApprovalRequests({ status: 'approved', storageChannels }).find(
    (entry) => entry.id === requestId && !entry.revocation
  );
}

/**
 * Revoke from the terminal. An agent session revokes as that agent (allowed
 * only for its own requests); otherwise as the local owner member, which the
 * store resolves itself (`revokeApprovalAsLocalOwner`); without an owner
 * member, the display name may revoke only what it requested or approved.
 */
export function revokeApprovalFromCli(
  request: ApprovalRequestRecord,
  params: Pick<CliOperatorPrincipalOptions, 'env'> & { reason?: string }
): ApprovalRequestRecord {
  const base = {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    reason: params.reason?.trim() || 'revoked from terminal via pnpm kyberion approvals --revoke',
  };
  const agent = detectCliAgentPrincipal(params.env);
  if (agent) return revokeApprovalRequest('mission_controller', { ...base, revokedBy: agent });
  const identity = resolveCliOperatorIdentity();
  if (identity.principalId) return revokeApprovalAsLocalOwner('mission_controller', base);
  return revokeApprovalRequest('mission_controller', { ...base, revokedBy: identity.displayName });
}
