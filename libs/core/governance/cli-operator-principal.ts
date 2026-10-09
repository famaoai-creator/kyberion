/**
 * One stable principal for the terminal CLI's approval records.
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
import { getRegisteredEnvText } from '../foundation/env.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import { resolveOperatorDisplayName } from '../surface/operator-identity.js';
import { resolveSeparationOfDutiesPolicy } from './approval-policy.js';

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

/**
 * Environment markers of an agent session. Kyberion's own agent runtime sets
 * `KYBERION_AGENT_ID` / `KYBERION_NHI_ID` / `KYBERION_RUN_ORIGIN=agent` (the
 * same signals `deriveTraceOrigin` classifies as `agent`); provider CLI
 * harnesses set their own marker in every child process they spawn.
 */
const AGENT_HARNESS_MARKERS: ReadonlyArray<{ env: string; equals?: string; agent: string }> = [
  { env: 'CLAUDECODE', agent: 'claude-code' },
  { env: 'CODEX_CLI', agent: 'codex-cli' },
  { env: 'CODEX_VERSION', agent: 'codex-cli' },
  { env: 'TERM_PROGRAM', equals: 'codex', agent: 'codex-cli' },
  { env: 'GEMINI_CLI', agent: 'gemini-cli' },
  { env: 'GROK_CLI', agent: 'grok-cli' },
  { env: 'CURSOR_AGENT', agent: 'cursor-cli' },
  { env: 'OPENCODE_CLI', agent: 'opencode-cli' },
];

/** Every environment variable {@link detectCliAgentPrincipal} reads (tests blank them). */
export const CLI_AGENT_SESSION_ENV: readonly string[] = [
  'KYBERION_AGENT_ID',
  'KYBERION_NHI_ID',
  'KYBERION_RUN_ORIGIN',
  ...new Set(AGENT_HARNESS_MARKERS.map((marker) => marker.env)),
  'AI_AGENT',
];

function envText(env: Env, name: string): string {
  return getRegisteredEnvText(name, { env })?.trim() ?? '';
}

/**
 * The agent principal this CLI process runs under, or null for a plain
 * terminal. A human typing a command into an agent session's shell is
 * indistinguishable from the agent and is treated as the agent.
 */
export function detectCliAgentPrincipal(env: Env = process.env): string | null {
  const agentId = envText(env, 'KYBERION_AGENT_ID');
  if (agentId) return agentId.includes(':') ? agentId : `agent:${agentId}`;
  const nhiId = envText(env, 'KYBERION_NHI_ID');
  if (nhiId) return nhiId;
  if (envText(env, 'KYBERION_RUN_ORIGIN').toLowerCase() === 'agent') {
    return 'agent:kyberion-runtime';
  }
  for (const marker of AGENT_HARNESS_MARKERS) {
    const value = envText(env, marker.env);
    if (!value) continue;
    if (marker.equals !== undefined && value.toLowerCase() !== marker.equals) continue;
    return `agent:${marker.agent}`;
  }
  const generic = envText(env, 'AI_AGENT');
  if (generic) return `agent:${generic.split(/[_\s]/u)[0] || 'unknown-harness'}`;
  return null;
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

export interface CliApprovalRequester {
  requestedBy: string;
  requestedByDisplayName?: string;
  source: 'explicit' | 'agent' | 'operator' | 'legacy';
}

/**
 * Who opens an approval request from a CLI or script. Order: an explicit
 * `--requested-by` (caller's choice, unchanged) → the agent session the CLI
 * runs in → the local owner member → the caller's legacy value (only while
 * separation of duties is off; with it on this throws a diagnostic instead).
 */
export function resolveCliApprovalRequester(
  params: CliOperatorPrincipalOptions & { explicit?: string | null; legacy: string }
): CliApprovalRequester {
  const explicit = params.explicit?.trim();
  if (explicit) return { requestedBy: explicit, source: 'explicit' };
  const agent = detectCliAgentPrincipal(params.env);
  if (agent) return { requestedBy: agent, source: 'agent' };
  const identity = resolveCliOperatorIdentity(params);
  if (identity.principalId) {
    return {
      requestedBy: identity.principalId,
      requestedByDisplayName: identity.displayName,
      source: 'operator',
    };
  }
  if (resolveSeparationOfDutiesPolicy().enabled) {
    throw missingIdentityError(
      'request',
      `no active owner member (would have recorded '${params.legacy}')`
    );
  }
  return { requestedBy: params.legacy, source: 'legacy' };
}

export interface CliApprovalDecider {
  decidedBy: string;
  decidedByDisplayName: string;
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
  if (params.decision === 'approved' && resolveSeparationOfDutiesPolicy().enabled) {
    const agent = detectCliAgentPrincipal(params.env);
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
  };
}
