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
 * signed-in Concierge or Chronos session.
 *
 * Separation of duties off: no challenge for ordinary requests (unchanged). A
 * decision typed inside an agent session is still recorded as the owner, but
 * marked `caller_supplied` with the agent principal, so it can never pass a
 * later separation-of-duties re-check.
 *
 * Human-only requests (HA-04, terminal attestation): approve and reject are
 * refused inside an agent session (environment markers or a provider CLI among
 * the parent processes) and without an interactive terminal; otherwise the
 * same challenge runs, showing the action, target, tenant, effect and the
 * presented digest, with a code derived from that digest, the request id, a
 * nonce and a 60 s expiry. A typed match records `terminal_attested` (A2) and
 * sends the digest to the store, which checks it against the request; the OS
 * user, tty and parent process lineage go to the audit trail. A2 stops a
 * mistaken or agent-driven decision, not a compromised account (plan §5.1).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  computeApprovalPresentedDigest,
  decideApprovalRequest,
  isSeparationOfDutiesEnabled,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { providerHarnessInProcessLineage } from '@agent/core/agent-execution-context';
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
  resolveCliTerminalEvidence,
  resolveCliTtyChallengeTerminal,
  type CliTerminalEvidence,
  type CliTtyIo,
} from './cli-tty-io.js';

/** How long a terminal attestation code stays valid (plan §5.1). */
export const CLI_TERMINAL_ATTESTATION_TTL_MS = 60_000;

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

interface TtyChallenge {
  decision: 'approved' | 'rejected';
  /** Human-only: terminal attestation (60 s code, refusal code `APPROVAL_HUMAN_PROOF_REQUIRED`). */
  humanOnly: boolean;
}

interface TtyAttestation {
  presentedDigest: string;
  codeExpiresAt: string;
}

/** The code is derived from what is shown, so it changes with the request and every run. */
function challengeCode(
  digest: string,
  requestId: string,
  expiresAt: string,
  nonce: string
): string {
  return createHash('sha256')
    .update(`${nonce}:${digest}:${requestId}:${expiresAt}`)
    .digest('hex')
    .slice(0, 6);
}

function describeRequest(request: ApprovalRequestRecord, digest: string): string[] {
  const via =
    request.requestedByContext?.actorId &&
    request.requestedByContext.actorId !== request.requestedBy
      ? ` (via ${request.requestedByContext.actorId})`
      : '';
  const target = request.target
    ? `${request.target.serviceId}/${request.target.secretKey} (${request.target.mutation})`
    : undefined;
  return [
    `  ${request.summary}`,
    `  requested by ${request.requestedBy}${via}`,
    ...(target ? [`  target: ${target}`] : []),
    ...(request.scope?.tenant_slug ? [`  tenant: ${request.scope.tenant_slug}`] : []),
    ...(request.accountability?.effectBinding
      ? [`  effect: ${request.accountability.effectBinding}`]
      : []),
    `  presented digest: ${digest}`,
  ];
}

/** The challenge needs a person at an interactive terminal; anything else is refused. */
function refuseNonInteractiveTerminal(
  request: ApprovalRequestRecord,
  io: CliTtyIo,
  challenge: TtyChallenge
): void {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    const evidence = `stdin.isTTY=${Boolean(io.stdin.isTTY)} stdout.isTTY=${Boolean(io.stdout.isTTY)}, request ${request.id}`;
    throw new Error(
      challenge.humanOnly
        ? `[APPROVAL_HUMAN_PROOF_REQUIRED] approval decision blocked — human-only request ${request.id} needs terminal attestation and this terminal is not interactive ` +
            '| next: run the command in an interactive terminal and type the code it prints, or decide it in a signed-in Concierge or Chronos session ' +
            `| evidence: ${evidence}`
        : '[POLICY_VIOLATION] approval decision blocked — separation of duties is on and this terminal is not interactive, ' +
            'so the approval cannot be confirmed at the keyboard ' +
            '| next: approve it in a signed-in Concierge or Chronos session, or run the command in an interactive terminal and answer its challenge ' +
            `| evidence: ${evidence}`
    );
  }
}

/**
 * Best-effort confirmation that a person at an interactive terminal decides:
 * refuses without a TTY, else prints the request, its presented digest and a
 * one-time code and proceeds only when the typed answer matches in time.
 */
async function confirmDecisionByTtyChallenge(
  request: ApprovalRequestRecord,
  io: CliTtyIo,
  timeoutMs: number,
  challenge: TtyChallenge
): Promise<TtyAttestation> {
  const verb = challenge.decision === 'approved' ? 'approve' : 'reject';
  refuseNonInteractiveTerminal(request, io, challenge);
  const digest = computeApprovalPresentedDigest(request);
  const ttlMs = challenge.humanOnly
    ? Math.min(timeoutMs, CLI_TERMINAL_ATTESTATION_TTL_MS)
    : timeoutMs;
  const expiresAtMs = Date.now() + ttlMs;
  const codeExpiresAt = new Date(expiresAtMs).toISOString();
  const code = challengeCode(digest, request.id, codeExpiresAt, randomBytes(8).toString('hex'));
  io.stdout.write(
    [
      '',
      `${challenge.decision === 'approved' ? 'Approve' : 'Reject'} ${request.id}: ${request.title}`,
      ...describeRequest(request, digest),
      `  the code expires at ${codeExpiresAt}`,
      `Type ${code} to ${verb} (anything else cancels): `,
    ].join('\n')
  );
  const typed = await readOneLine(io.stdin, ttlMs);
  if (typed === null || Date.now() > expiresAtMs) {
    io.stdout.write('\n');
    throw new Error(
      '[POLICY_VIOLATION] challenge timed out — no code was typed within ' +
        `${Math.round(ttlMs / 1000)}s, so the decision was not recorded ` +
        '| next: re-run the command and type the code it prints, or decide it in a signed-in Concierge or Chronos session ' +
        `| evidence: request ${request.id}, timeout ${ttlMs}ms (default ${CLI_TTY_CHALLENGE_TIMEOUT_MS}ms)`
    );
  }
  if (typed.trim().toLowerCase() !== code) {
    throw new Error(
      `[POLICY_VIOLATION] ${challenge.decision === 'approved' ? 'approval' : 'rejection'} decision cancelled — the typed challenge did not match ` +
        '| next: re-run the command and type the code it prints ' +
        `| evidence: request ${request.id}`
    );
  }
  return { presentedDigest: digest, codeExpiresAt };
}

/** A provider CLI among the parent processes makes this an agent session (plan §5.1). */
function refuseProviderHarnessLineage(
  request: ApprovalRequestRecord,
  evidence: CliTerminalEvidence
) {
  const harness = providerHarnessInProcessLineage(evidence.lineage.map((entry) => entry.command));
  if (!harness) return;
  throw new Error(
    `[APPROVAL_HUMAN_PROOF_REQUIRED] approval decision blocked — this command runs under a provider CLI (${harness}) and request ${request.id} is human-only ` +
      '| next: run the decision from your own terminal, outside the agent session, or decide it in a signed-in Concierge or Chronos session ' +
      `| evidence: parent process lineage ${evidence.lineage.map((entry) => entry.command).join(' < ')}`
  );
}

function recordTerminalAttestation(
  decided: ApprovalRequestRecord,
  params: { decision: 'approved' | 'rejected'; decidedBy: string },
  attestation: TtyAttestation,
  evidence: CliTerminalEvidence
): void {
  auditChain.record({
    agentId: params.decidedBy,
    action: 'approval_decision',
    operation: 'terminal_attested',
    result: 'completed',
    reason: `human-only ${params.decision} confirmed at an interactive terminal by OS user ${evidence.osUser} (A2, terminal_attested)`,
    correlationId: decided.correlationId,
    metadata: {
      requestId: decided.id,
      decision: params.decision,
      decidedBy: params.decidedBy,
      operatorId: params.decidedBy,
      osUser: evidence.osUser,
      tty: evidence.tty,
      parentLineage: evidence.lineage,
      presentedDigest: attestation.presentedDigest,
      codeExpiresAt: attestation.codeExpiresAt,
    },
  });
}

export async function decideApprovalFromCli(
  request: ApprovalRequestRecord,
  params: CliOperatorPrincipalOptions & {
    decision: 'approved' | 'rejected';
    note: string;
  }
): Promise<ApprovalRequestRecord> {
  const humanOnly = request.accountability?.finalDecision === 'human_only';
  const decider = resolveCliApprovalDecider({ ...params, humanOnly });
  const challenged = humanOnly || (params.decision === 'approved' && isSeparationOfDutiesEnabled());
  const terminal = challenged ? resolveCliTtyChallengeTerminal() : undefined;
  let evidence: CliTerminalEvidence | undefined;
  if (humanOnly && terminal) {
    refuseNonInteractiveTerminal(request, terminal.io, { decision: params.decision, humanOnly });
    evidence = resolveCliTerminalEvidence();
    refuseProviderHarnessLineage(request, evidence);
  }
  let attestation: TtyAttestation | undefined;
  if (terminal) {
    attestation = await confirmDecisionByTtyChallenge(request, terminal.io, terminal.timeoutMs, {
      decision: params.decision,
      humanOnly,
    });
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
    authMethod: humanOnly ? 'terminal_attested' : 'manual',
    decidedByType: 'human',
    authenticated: true,
    ...(attestation
      ? { presentedDigest: attestation.presentedDigest }
      : {
          payloadHash: request.accountability?.payloadHash,
          effectBinding: request.accountability?.effectBinding,
        }),
    note: params.note,
  });
  if (attestation && evidence) {
    recordTerminalAttestation(
      decided,
      { ...params, decidedBy: decider.decidedBy },
      attestation,
      evidence
    );
  }
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
