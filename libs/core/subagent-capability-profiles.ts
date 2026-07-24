import { auditChain } from './audit-chain.js';
import { recordGovernanceAction } from './kill-switch.js';
import { policyEngine, type PolicyDecision } from './policy-engine.js';
import { getDefaultWorkerEventStream } from './worker-event-stream.js';

/**
 * Subagent capability tiers (KD-05).
 *
 * Runtime concretization of the `least-agency-enforcement` policy
 * (knowledge/product/governance/agent-policies.yaml): every delegation
 * carries a named capability tier, and any op it attempts is resolved to a
 * `has_capability` fact from that tier's `allowedOps` before the policy
 * engine's existing `has_capability === false -> deny` rule fires. No new
 * policy rule was needed — this module is the enforcement-side wiring the
 * plan calls for.
 *
 * Modeled on kimi-code's `AgentProfile`, adapted to Kyberion's declarative
 * policy engine instead of kimi-code's DI/Scope container (see
 * KIMI_CODE_ADOPTION_PLAN §2 "不採用").
 *
 * Registration ceremony: to add a tier, add ONE entry to
 * {@link SUBAGENT_CAPABILITY_PROFILES} below. Everything else derives from
 * that array:
 *  - {@link describeSubagentCapabilityCatalog} (consumed by agent-dispatch's
 *    `invoke_agent` tool description, so the model always sees the current
 *    tier list);
 *  - the `agent_profile` enum on that same tool's input schema;
 *  - this module's own boundary tests, which iterate the registry instead
 *    of hardcoding tier names.
 */

export interface SubagentCapabilityProfile {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  /** Op ids this tier may invoke. `'*'` means "every non-reserved op". */
  readonly allowedOps: readonly string[] | '*';
  readonly systemPromptPrefix: string;
  /**
   * CLI/Agent-SDK tool-name projection of this tier (Claude Code `tools:`
   * frontmatter vocabulary and Agent SDK `allowedTools`). This is the single
   * source of truth both `scripts/generate_subagent_definitions.ts` (CT-01
   * `.claude/agents/*.md` frontmatter) and `libs/core/agent-dispatch.ts`
   * (CT-02 `HarnessSubagentDispatcher` allowlist) derive from — see
   * {@link SUBAGENT_PROFILE_CLI_TOOLS}.
   */
  readonly cliTools: readonly string[];
}

/**
 * KD-01 (not yet implemented) will introduce a worker goal state machine
 * with typed `goal:*` ops (`goal:update`, ...) owned by the main worker's
 * autonomous driver loop. Those ops must NEVER be reachable by a delegated
 * subagent, no matter which capability tier it runs under — a subagent that
 * could mutate the parent worker's goal state would break the "1 owner
 * mutates mission/goal state" invariant this whole tier system exists to
 * enforce. This prefix check runs before any profile's `allowedOps` is
 * consulted, so a future tier cannot inadvertently re-open it by listing
 * `'goal:*'` (or `'*'`) in its allowlist.
 */
export const RESERVED_GOAL_OP_PREFIX = 'goal:';

export const SUBAGENT_CAPABILITY_PROFILES: readonly SubagentCapabilityProfile[] = [
  {
    name: 'implementer',
    description: 'Full read/write/exec tier for delegated implementation work.',
    whenToUse:
      'The delegated task requires editing files, running commands, or producing artifacts within its assigned scope.',
    allowedOps: '*',
    systemPromptPrefix:
      'You are a delegated implementer sub-agent. You may read, write, and execute within your assignment scope.',
    cliTools: [
      'Read',
      'Grep',
      'Glob',
      'NotebookRead',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
    ],
  },
  {
    name: 'explorer',
    description: 'Read-only tier for investigation, search, and research delegations.',
    whenToUse:
      'The delegated task is to search, read, or summarize — it must never change repository or knowledge state.',
    allowedOps: [
      'file:read',
      'file:read_file',
      'file:read_json',
      'file:list',
      'file:search',
      'file:exists',
      'file:stat',
      'file:tail',
      'network:fetch',
      'wisdom:knowledge_search',
      'wisdom:history_search',
      'wisdom:query',
      'wisdom:read_file',
      'wisdom:glob_files',
    ],
    systemPromptPrefix:
      'You are a delegated explorer sub-agent. You are read-only: you may search and read, but you must never write, delete, or execute.',
    cliTools: ['Read', 'Grep', 'Glob', 'NotebookRead'],
  },
  {
    name: 'planner',
    description: 'No-exec, no-write tier for planning and decomposition delegations.',
    whenToUse:
      'The delegated task is to produce a plan, breakdown, or recommendation in text — no tool execution at all.',
    allowedOps: [],
    systemPromptPrefix:
      'You are a delegated planner sub-agent. Do not call any file, search, or execution tool — respond with reasoning and text only.',
    cliTools: [],
  },
] as const;

/**
 * KD-05 profile -> CLI/Agent-SDK tool-name projection, keyed by profile
 * name. Derived (not hand-typed) from {@link SUBAGENT_CAPABILITY_PROFILES}
 * so there is exactly one place a tier's tool surface is declared; both
 * `scripts/generate_subagent_definitions.ts` (CT-01) and
 * `libs/core/agent-dispatch.ts` (CT-02) consume this map instead of keeping
 * their own hand-mirrored copies.
 */
export const SUBAGENT_PROFILE_CLI_TOOLS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    SUBAGENT_CAPABILITY_PROFILES.map((profile) => [profile.name, profile.cliTools])
  );

const PROFILE_BY_NAME = new Map(
  SUBAGENT_CAPABILITY_PROFILES.map((profile) => [profile.name, profile])
);

export function getSubagentCapabilityProfile(name: string): SubagentCapabilityProfile {
  const profile = PROFILE_BY_NAME.get(name);
  if (!profile) {
    const known = listSubagentCapabilityProfileNames().join(', ');
    throw new Error(
      `[SUBAGENT_PROFILE_UNKNOWN] "${name}" is not a registered capability tier. Known tiers: ${known}`
    );
  }
  return profile;
}

export function listSubagentCapabilityProfileNames(): string[] {
  return SUBAGENT_CAPABILITY_PROFILES.map((profile) => profile.name);
}

/**
 * Team-role (knowledge/product/orchestration/team-roles/*.json) -> KD-05
 * capability tier. `implementer`/`tester`/`operator` keep full write/exec
 * access; analysis/critique-shaped roles (review, dissent, adversarial)
 * project onto `explorer` (read-only investigation); coordination/strategy
 * roles project onto `planner` (no tool execution). Roles not listed fall
 * back to {@link DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE} — the safest
 * (read-only) tier — rather than silently inheriting implementer's write
 * access. Moved here from `scripts/generate_subagent_definitions.ts` (CT-01)
 * so it is the one place this repo defines the mapping.
 */
export const TEAM_ROLE_CAPABILITY_PROFILE: Readonly<Record<string, string>> = {
  implementer: 'implementer',
  tester: 'implementer',
  operator: 'implementer',
  reviewer: 'explorer',
  devils_advocate: 'explorer',
  attacker: 'explorer',
  defender: 'explorer',
  tracker: 'explorer',
  scribe: 'explorer',
  experience_designer: 'explorer',
  surface_liaison: 'explorer',
  counterparty_persona: 'explorer',
  relationship_curator: 'explorer',
  facilitator: 'planner',
  planner: 'planner',
  product_strategist: 'planner',
  orchestrator: 'planner',
  owner: 'planner',
};

export const DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE = 'explorer';

/** Resolve a team role to its KD-05 capability tier, per {@link TEAM_ROLE_CAPABILITY_PROFILE}. */
export function resolveCapabilityProfileForTeamRole(teamRole: string): string {
  return TEAM_ROLE_CAPABILITY_PROFILE[teamRole] ?? DEFAULT_TEAM_ROLE_CAPABILITY_PROFILE;
}

/**
 * Dynamic catalog text. Dispatch-side tool descriptions embed this so the
 * model always sees the current, live tier list rather than a description
 * frozen at the time the tool was authored (KD-05 acceptance criterion 2).
 */
export function describeSubagentCapabilityCatalog(): string {
  return SUBAGENT_CAPABILITY_PROFILES.map((profile) => {
    const ops =
      profile.allowedOps === '*'
        ? 'all ops'
        : profile.allowedOps.length > 0
          ? profile.allowedOps.join(', ')
          : 'none (no tool execution)';
    return `- ${profile.name}: ${profile.description} Use when: ${profile.whenToUse} Allowed ops: ${ops}.`;
  }).join('\n');
}

function isReservedGoalOp(opId: string): boolean {
  return opId.startsWith(RESERVED_GOAL_OP_PREFIX);
}

/**
 * Whether `opId` is inside `profile`'s allowlist. Reserved `goal:*` ops are
 * always excluded, regardless of tier (see {@link RESERVED_GOAL_OP_PREFIX}).
 */
export function isOpAllowedForProfile(profile: SubagentCapabilityProfile, opId: string): boolean {
  if (isReservedGoalOp(opId)) return false;
  if (profile.allowedOps === '*') return true;
  return profile.allowedOps.includes(opId);
}

export interface SubagentOpCheckInput {
  /** Registered tier name (e.g. 'explorer'). Throws if unknown. */
  profileName: string;
  /** Op id the delegation is attempting, e.g. 'file:write'. */
  opId: string;
  agentId?: string;
  delegationId?: string;
}

/**
 * Gate a single op call against a subagent's capability tier.
 *
 * Runs the check through the declarative policy engine's
 * `least-agency-enforcement` rule (`has_capability === false -> deny`) so
 * tier enforcement is auditable through the same mechanism as every other
 * governance decision in this repo, rather than a parallel ad hoc if/throw.
 * On denial: records to the kill-switch audit trail (matching
 * `assertOperationPolicy`'s pattern in operation-policy-gate.ts) and emits a
 * best-effort `governance_action` envelope on the default worker event
 * stream — KD-05 acceptance criterion 1.
 */
export function assertSubagentOpAllowed(input: SubagentOpCheckInput): PolicyDecision {
  const profile = getSubagentCapabilityProfile(input.profileName);
  const hasCapability = isOpAllowedForProfile(profile, input.opId);
  const agentId = input.agentId ?? 'subagent';

  const decision = policyEngine.evaluate({
    agentId,
    operation: input.opId,
    agent_tier: profile.name,
    has_capability: hasCapability,
  });

  if (!decision.allowed) {
    const reason = isReservedGoalOp(input.opId)
      ? "goal:* ops are reserved for the main worker's goal driver (KD-01) and are never exposed to sub-agents."
      : decision.message ||
        `Op "${input.opId}" is outside the "${profile.name}" tier's allowed ops.`;

    recordGovernanceAction(agentId, input.opId, `subagent_tier_denied:${profile.name}`, true);
    auditChain.record({
      agentId,
      action: 'policy_violation',
      operation: input.opId,
      result: 'failed',
      reason,
      metadata: {
        matched_policy: decision.matchedPolicy || '',
        subagent_profile: profile.name,
        ...(input.delegationId ? { delegation_id: input.delegationId } : {}),
      },
    });
    try {
      getDefaultWorkerEventStream().emit('governance_action', {
        kind: 'subagent_op_denied',
        profile: profile.name,
        op: input.opId,
        reason,
        ...(input.delegationId ? { delegation_id: input.delegationId } : {}),
      });
    } catch {
      // Stream projection is best-effort; the audit record above is authoritative.
    }

    throw new Error(
      `[SUBAGENT_POLICY_BLOCKED] ${input.opId} denied for tier "${profile.name}": ${reason}`
    );
  }

  return decision;
}
