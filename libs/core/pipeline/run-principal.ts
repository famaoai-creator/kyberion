import {
  resolveMemberByPrincipal,
  type MemberRegistryPathOptions,
} from '../organization/member-registry.js';
import { detectAgentExecutionContext } from '../agent/agent-execution-context.js';
import { getRegisteredEnvText } from '../foundation/env.js';

/**
 * Who a pipeline run executes as (Run Principal). `attended` needs a present
 * terminal, a process no agent drives, AND an active Member behind it;
 * anything else is `unattended`. A run-manifest binding additionally requires
 * that Member to be the approving charter's accountable human (or a declared
 * deputy) — see {@link principalForAccountable}. It selects how out-of-manifest
 * effects are approved and which manifest-bound charters apply — it is never
 * a credential exception.
 */
export type RunPrincipalMode = 'attended' | 'unattended';

export interface RunPrincipal {
  mode: RunPrincipalMode;
  /** The active Member a present terminal resolved to (attended only). */
  memberId?: string;
  reason: string;
}

export interface ResolveRunPrincipalInput {
  /** Terminal presence (CLI) or the library caller's claim — never sufficient alone. */
  hasHuman: boolean | undefined;
  /** Environment the agent markers are read from (tests); defaults to the process env. */
  env?: Record<string, string | undefined>;
}

/**
 * `hasHuman` is the runner's terminal presence (true / false / undefined =
 * unknown) or a library caller's claim. Presence alone never attends a run:
 * an agent-driven process (provider CLI harness, Kyberion agent runtime,
 * terminal-actuator PTY) or an unregistered / suspended owner leaves it
 * unattended.
 */
export function resolveRunPrincipal(
  input: ResolveRunPrincipalInput,
  options: MemberRegistryPathOptions = {}
): RunPrincipal {
  if (input.hasHuman === false)
    return { mode: 'unattended', reason: 'non-interactive execution boundary' };
  if (input.hasHuman !== true) return { mode: 'unattended', reason: 'no terminal present' };
  // An agent's TTY is not a human at the terminal (markers are advisory: a
  // positive answer is reliable enough to refuse attended, a negative proves nothing).
  const agent = detectAgentExecutionContext(input.env ? { env: input.env } : {});
  if (agent.isAgent)
    return {
      mode: 'unattended',
      reason: `agent-driven process${agent.principal ? ` (${agent.principal})` : ''}`,
    };
  let member: ReturnType<typeof resolveMemberByPrincipal> = null;
  try {
    member = resolveMemberByPrincipal({ source: 'loopback' }, options);
  } catch {
    member = null;
  }
  if (!member) return { mode: 'unattended', reason: 'terminal present but no active owner member' };
  return { mode: 'attended', memberId: member.member_id, reason: 'terminal + active member' };
}

/**
 * Terminal presence of a CLI entry, as the pipeline runner resolves it
 * (`resolvePipelineHumanPresence`): `KYBERION_NON_INTERACTIVE=1` → false, an
 * interactive stdin and stdout → true, otherwise unknown. Never sufficient to
 * attend a run on its own ({@link resolveRunPrincipal}).
 */
export function terminalHumanPresence(): boolean | undefined {
  if (getRegisteredEnvText('KYBERION_NON_INTERACTIVE') === '1') return false;
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  return undefined;
}

/**
 * The principal a run-manifest binding may use: `attended` only when the
 * terminal's Member is the charter's accountable human (`user:<member_id>`)
 * or one of its declared deputies. Anyone else at the terminal runs the
 * manifest unattended.
 */
export function principalForAccountable(
  principal: RunPrincipal,
  accountable: { actor: string; deputies?: readonly string[] }
): RunPrincipal {
  if (principal.mode !== 'attended' || !principal.memberId) return principal;
  const actor = `user:${principal.memberId}`;
  if (actor === accountable.actor || (accountable.deputies ?? []).includes(actor)) return principal;
  return {
    mode: 'unattended',
    reason: `terminal member ${principal.memberId} is not the approving owner (${accountable.actor}) or a deputy`,
  };
}
