/**
 * One stable principal for the terminal CLI's approval records.
 *
 * Trust: everything here is best effort. The terminal cannot authenticate the
 * person at the keyboard. Agent-session markers (environment variables) are
 * advisory — an agent can clear them — and the TTY challenge the terminal asks
 * for under separation of duties (`scripts/lib/approval-cli-decision.ts`) can
 * be answered by an agent driving a PTY (for example through
 * terminal-actuator). The strong path for a separated approval is an
 * authenticated surface (Chronos or presence-studio), which records
 * `user:<member_id>` from a verified session.
 *
 * The terminal runs on this machine as its local owner — the same member the
 * chronos / presence-studio loopback viewer resolves to
 * (`resolveMemberByPrincipal({ source: 'loopback' })`). Approval requests the
 * operator opens from a CLI or script record that member as `requestedBy`, and
 * `pnpm kyberion approvals --approve` records it as `decidedBy`, both as
 * `user:<member_id>`. The onboarding display name is kept separately
 * (`requestedByDisplayName` / `decidedByDisplayName`) for people to read; it
 * is never compared.
 *
 * A CLI invoked from inside an agent session (a Kyberion agent runtime, or a
 * provider CLI harness such as Claude Code) opens requests as that agent, not
 * as the owner, so a human approving an agent-opened request is not mistaken
 * for a self-approval.
 *
 * With separation of duties off nothing new is refused: when no owner member
 * exists the legacy values (persona, component name, display name) are
 * recorded as before. With it on, a missing identity is reported instead of
 * silently recording a value that cannot prove separation.
 */
import {
  agentExecutionContextEnvNames,
  detectAgentExecutionContext,
} from '../agent-execution-context.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import { resolveOperatorDisplayName } from '../surface/operator-identity.js';
import { resolveSeparationOfDutiesPolicy } from './approval-policy.js';
import type { ApprovalRequesterRef } from './approval-requester.js';

type Env = Record<string, string | undefined>;

export interface CliOperatorPrincipalOptions {
  env?: Env;
  /** Member registry root (tests). Defaults to the repository root. */
  rootDir?: string;
}

export interface CliOperatorIdentity {
  /** `user:<member_id>` of the local owner member, or null when none is active. */
  principalId: string | null;
  /** Onboarding display name, for people to read. */
  displayName: string;
}

/** The command that provisions the owner member from the terminal. */
export const CLI_OPERATOR_PROVISION_COMMAND = 'pnpm organization member ensure-owner';

/** Every environment variable {@link detectCliAgentPrincipal} reads (tests blank them). */
export function cliAgentSessionEnv(): string[] {
  return agentExecutionContextEnvNames();
}

/**
 * The agent principal this CLI process runs under, or null for a plain
 * terminal (see `detectAgentExecutionContext`). A human typing a command into
 * an agent session's shell is indistinguishable from the agent and is treated
 * as the agent.
 */
export function detectCliAgentPrincipal(env: Env = process.env): string | null {
  return detectAgentExecutionContext({ env }).principal;
}

/** The local owner member as the CLI's operator principal (never throws). */
export function resolveCliOperatorIdentity(
  options: CliOperatorPrincipalOptions = {}
): CliOperatorIdentity {
  const displayName = resolveOperatorDisplayName();
  try {
    const owner = resolveMemberByPrincipal(
      { source: 'loopback' },
      options.rootDir ? { rootDir: options.rootDir } : {}
    );
    return { principalId: owner ? `user:${owner.member_id}` : null, displayName };
  } catch {
    return { principalId: null, displayName };
  }
}

function missingIdentityError(side: 'request' | 'decision', evidence: string): Error {
  return new Error(
    `[POLICY_VIOLATION] approval ${side} blocked — separation of duties is on and this terminal has ` +
      'no stable operator identity, so the record could not prove who acted ' +
      `| next: run \`${CLI_OPERATOR_PROVISION_COMMAND}\` (provisions the local owner member, recorded as user:owner) and retry ` +
      `| evidence: ${evidence}`
  );
}

export interface CliApprovalRequester extends ApprovalRequesterRef {
  /** The detected principal; always recorded (`requestedByContext.actorId`). */
  actorId: string;
  /** How the detected principal was found. */
  source: 'agent' | 'operator' | 'legacy';
}

/**
 * Who opens an approval request from a CLI or script. The detected principal
 * is the agent session the CLI runs in, else the local owner member, else the
 * caller's legacy value (only while separation of duties is off; with it on
 * this throws a diagnostic). It is always recorded as `actorId`; an explicit
 * `--requested-by` becomes `requestedBy` and adds an identity, so an owner
 * cannot hide behind `--requested-by agent:x` and then approve.
 */
export function resolveCliApprovalRequester(
  params: CliOperatorPrincipalOptions & { explicit?: string | null; legacy: string }
): CliApprovalRequester {
  const explicit = params.explicit?.trim() || undefined;
  const agent = detectCliAgentPrincipal(params.env);
  const identity = resolveCliOperatorIdentity(params);
  let detected: Pick<CliApprovalRequester, 'actorId' | 'source' | 'displayName'>;
  if (agent) detected = { actorId: agent, source: 'agent' };
  else if (identity.principalId) {
    detected = {
      actorId: identity.principalId,
      source: 'operator',
      displayName: identity.displayName,
    };
  } else if (resolveSeparationOfDutiesPolicy().enabled) {
    throw missingIdentityError(
      'request',
      `no active owner member (would have recorded '${explicit ?? params.legacy}')`
    );
  } else detected = { actorId: params.legacy, source: 'legacy' };
  return { requestedBy: explicit ?? detected.actorId, ...detected };
}

export interface CliApprovalDecider {
  decidedBy: string;
  decidedByDisplayName: string;
  /**
   * Set when the terminal is an agent session (separation of duties off):
   * the decision is recorded as `caller_supplied`, so it can never pass a later
   * separation-of-duties re-check.
   */
  deciderIdentitySource?: 'caller_supplied';
  decidedInAgentSession?: string;
}

/**
 * Who decides from the terminal (`pnpm kyberion approvals --approve`). The
 * local owner member when one exists; otherwise the display name, as before.
 * With separation of duties on, an approval is refused when the identity is
 * missing, or when the terminal is an agent session — agents must not decide
 * for the human, and from inside the session the two cannot be told apart.
 * Rejections are never refused (declining only withdraws).
 */
export function resolveCliApprovalDecider(
  params: CliOperatorPrincipalOptions & { decision: 'approved' | 'rejected' }
): CliApprovalDecider {
  const identity = resolveCliOperatorIdentity(params);
  const agent = detectCliAgentPrincipal(params.env);
  if (params.decision === 'approved' && resolveSeparationOfDutiesPolicy().enabled) {
    if (agent) {
      throw new Error(
        `[POLICY_VIOLATION] approval decision blocked — separation of duties is on and this command runs inside an agent session (${agent}), ` +
          'so the decider cannot be shown to be the human ' +
          '| next: run the approval from your own terminal, outside the agent session ' +
          `| evidence: agent session marker resolved to ${agent}`
      );
    }
    if (!identity.principalId) {
      throw missingIdentityError(
        'decision',
        `no active owner member (display name '${identity.displayName}')`
      );
    }
  }
  return {
    decidedBy: identity.principalId ?? identity.displayName,
    decidedByDisplayName: identity.displayName,
    ...(agent
      ? { deciderIdentitySource: 'caller_supplied' as const, decidedInAgentSession: agent }
      : {}),
  };
}
