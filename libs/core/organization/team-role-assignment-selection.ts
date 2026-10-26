import type { ProviderInfo } from '../provider/provider-discovery.js';
import { performanceScoreAdjustment } from '../agent/agent-performance-index.js';
import { modelPerformanceScoreAdjustment } from '../reasoning/model-performance-index.js';
import { modelRoleFitnessScoreAdjustment } from '../reasoning/model-role-fitness.js';
import { deriveAgentNhiId } from '../agent/agent-identity.js';
import {
  resolveAgentProviderTarget,
  type ResolvedAgentProviderTarget,
} from '../agent/agent-provider-resolution.js';
import { resolveSelectionHints } from '../agent/agent-manifest.js';
import { resolveTeamRoleSelectionHints } from './team-role-selection.js';
import { resolveModelProvider } from '../reasoning/reasoning-model-routing.js';
import { loadProviderConfig } from '../provider/provider-config.js';
import type { ContextSecurityScope } from '../context-security-scope.js';
import { resolveWorkforceLoad, type WorkforceLoadIndex } from '../workforce/workforce-load.js';
import { workerLoadPenalty } from '../workforce/worker-assignment-policy.js';
import { providerCanProjectProfile } from '../provider/provider-permission-profiles.js';
import { resolveCapabilityProfileForTeamRole } from '../subagent-capability-profiles.js';
import { canProvideGovernedTaskTools } from '../agent/agent-exec-adapter-bridge.js';

export interface AuthorityRoleRecord {
  description: string;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
}

export interface TeamRoleRecord {
  description: string;
  required_capabilities: string[];
  compatible_authority_roles: string[];
  allowed_delegate_team_roles: string[];
  escalation_parent_team_role: string | null;
  required_scope_classes: string[];
  ownership_scope: string;
  selection_hints?: {
    preferred_agents?: string[];
    preferred_models?: string[];
  };
  autonomy_level: 'low' | 'medium' | 'high';
}

export interface AgentProfileRecord {
  authority_roles: string[];
  team_roles: string[];
  capabilities: string[];
  selection_hints?: {
    preferred_provider?: string;
    preferred_modelId?: string;
  };
  provider_strategy?: 'strict' | 'preferred' | 'adaptive';
  fallback_providers?: string[];
  /**
   * Declared NHI scale-out: how many instances of this identity may exist.
   * The index expands `instance_count > 1` into `<id>-2..-N` clones that share
   * every field except instance metadata — each clone is its own accountable
   * NHI, so the existing busy/load-penalty machinery spreads work across them
   * unchanged. See AGENT_INSTANCE_POOL_PLAN.
   */
  instance_count?: number;
  /** Set on synthesized instances — the base profile they were cloned from. */
  instance_of?: string;
  /** Set on synthesized instances — 1-based ordinal inside the pool. */
  instance_index?: number;
}

/**
 * TC-01: how a roster role relates to the mission right now.
 *
 * - `assigned`  — staffed: an actor is bound, a staffing record exists and a
 *                 runtime may be spawned for it.
 * - `standby`   — on the roster with a resolved candidate actor, but not
 *                 staffed. Promoted to `assigned` when work demands the role,
 *                 which is a pure state transition: the candidate was already
 *                 selected at composition time, so promotion never re-runs
 *                 selection and stays reproducible.
 * - `unfilled`  — no compatible actor exists in the pool. A real staffing gap,
 *                 detected at composition time even for standby roles.
 */
export type MissionTeamAssignmentStatus = 'assigned' | 'standby' | 'unfilled';

/** Operator intent is independent from the resolved, refreshable assignment. */
export interface MissionTeamRoleSelection {
  mode: 'auto' | 'preferred' | 'fixed';
  agent_id?: string;
  provider?: string;
  model_id?: string;
  /** Runtime-only eligibility; dispatch still validates the live task lease and tool binding. */
  execution_route?: 'agent_runtime';
}

export interface MissionTeamSelectionResolution {
  source: 'legacy' | 'auto' | 'requested' | 'fallback' | 'blocked';
  reason: string;
}

export function normalizeMissionTeamRoleSelection(
  value: MissionTeamRoleSelection
): MissionTeamRoleSelection {
  if (!value || !['auto', 'preferred', 'fixed'].includes(value.mode)) {
    throw new Error(
      '[MISSION_TEAM_SELECTION_INVALID] Selection mode must be auto, preferred or fixed.'
    );
  }
  for (const key of Object.keys(value)) {
    if (!['mode', 'agent_id', 'provider', 'model_id', 'execution_route'].includes(key)) {
      throw new Error('[MISSION_TEAM_SELECTION_INVALID] Unsupported selection field: ' + key);
    }
  }
  const normalized: MissionTeamRoleSelection = { mode: value.mode };
  if (value.execution_route !== undefined) {
    if (value.execution_route !== 'agent_runtime')
      throw new Error('[MISSION_TEAM_SELECTION_INVALID] Unsupported execution route.');
    normalized.execution_route = value.execution_route;
  }
  for (const key of ['agent_id', 'provider', 'model_id'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key]!.trim()) {
      throw new Error(
        '[MISSION_TEAM_SELECTION_INVALID] Selection dimensions must be nonempty strings.'
      );
    }
    normalized[key] = value[key]!.trim();
  }
  if (
    value.mode === 'auto' &&
    (normalized.agent_id || normalized.provider || normalized.model_id)
  ) {
    throw new Error(
      '[MISSION_TEAM_SELECTION_INVALID] Auto mode does not accept target dimensions.'
    );
  }
  if (
    value.mode !== 'auto' &&
    !normalized.agent_id &&
    !normalized.provider &&
    !normalized.model_id
  ) {
    throw new Error(
      '[MISSION_TEAM_SELECTION_INVALID] Preferred and fixed modes require a target dimension.'
    );
  }
  return normalized;
}

export interface MissionTeamAssignment {
  requested_selection?: MissionTeamRoleSelection;
  selection_resolution?: MissionTeamSelectionResolution;
  team_role: string;
  required: boolean;
  status: MissionTeamAssignmentStatus;
  /**
   * TC-04: why this role is on the roster — `structural` (always staffed),
   * `obligation` (required by the governed obligations catalog and therefore
   * not removable by a template or organization overlay), `template`
   * (organization preference), `restaff` (added mid-mission because work
   * demanded a role the roster did not have — TC-06). Audits read the
   * roster's justification from here instead of inferring it from the
   * template name.
   */
  role_sources?: Array<'structural' | 'obligation' | 'template' | 'restaff'>;
  agent_id: string | null;
  /** When the selected agent is a cloned NHI instance: the base profile id. */
  instance_of?: string;
  instance_index?: number;
  actor_type?: 'agent' | 'human' | 'service';
  resource?: import('../mission/mission-team-binding.js').WorkforceResourceRef;
  accountable_human_id?: string | null;
  runtime_identity?: string | null;
  authority_role: string | null;
  delegation_contract: {
    ownership_scope: string;
    allowed_delegate_team_roles: string[];
    escalation_parent_team_role: string | null;
    required_scope_classes: string[];
    resolved_scope_classes: string[];
    allowed_write_scopes: string[];
  } | null;
  provider: string | null;
  modelId: string | null;
  required_capabilities: string[];
  notes: string;
  model_hint?: {
    tier: 'small' | 'standard' | 'large';
    execution_tier?: 'fast' | 'standard' | 'deep';
    effort: 'low' | 'medium' | 'high';
    model_id: string;
    route_reason: string;
  };
  organization_role_id?: string;
  perspective_ids?: string[];
  reasoning_route_id?: string;
  security_scope?: ContextSecurityScope;
  selection_reason_codes?: string[];
}

interface SelectionCandidate {
  profile: AgentProfileRecord;
  agentId: string;
  authorityRole: string;
  authorityRecord: AuthorityRoleRecord;
  resolvedTarget: ResolvedAgentProviderTarget;
  score: number;
  /** Set when the preferred provider could not project the role's tier and an alternate was substituted. */
  projectionFallback?: { from: string; tier: string };
}

function selectedModelHasHint(modelId: string, preferredModels: Set<string>): boolean {
  return preferredModels.has(
    String(modelId || '')
      .trim()
      .toLowerCase()
  );
}

export interface RoleSeparationConstraints {
  /** Hard separation-of-duties: these actors must not take this role (falls back if it would leave the role unstaffed). */
  excludeAgents?: Array<string | null | undefined>;
  /** Soft: penalize these actors so independent alternatives win when available. */
  avoidAgents?: Array<string | null | undefined>;
  /** Soft: penalize these providers (heterogeneous review — a different model family reviews the work). */
  avoidProviders?: Array<string | null | undefined>;
}

export interface TeamProviderPreference {
  provider: string;
  modelId?: string;
  strategy?: 'preferred' | 'adaptive' | 'strict';
}

// Outweighs the operator preferred_agents bonus (20) so independence beats
// habit, but stays under two capability hits (2×10 + provider bonus) so a
// clearly better-qualified duplicate actor can still win.
const SOD_AVOID_AGENT_PENALTY = 24;
const SOD_AVOID_PROVIDER_PENALTY = 6;

export interface SelectAgentForTeamRoleInput {
  teamRole: string;
  teamRoleRecord: TeamRoleRecord;
  authorityRoles: Record<string, AuthorityRoleRecord>;
  agents: Record<string, AgentProfileRecord>;
  routingHint?: { model_id: string };
  separation?: RoleSeparationConstraints;
  /** NI-01: org segment for the derived nhi_id; defaults to the active organization profile. */
  organizationId?: string;
  tier?: string;
  providerPreference?: TeamProviderPreference;
  requestedSelection?: MissionTeamRoleSelection;
  /** Passing an empty cache must never trigger discovery or provider probes. */
  discoveredProviders?: ProviderInfo[];
  /**
   * TC-09: observed workforce load, built once per composition pass. Selection
   * prefers an actor that is not already carrying work; the penalty is capped
   * so load never outweighs a capability match.
   */
  loadIndex?: WorkforceLoadIndex;
}

export function selectAgentForTeamRole(input: SelectAgentForTeamRoleInput): MissionTeamAssignment {
  const {
    teamRole,
    teamRoleRecord,
    authorityRoles,
    agents,
    routingHint,
    separation,
    organizationId,
    providerPreference,
    loadIndex,
    discoveredProviders,
  } = input;
  const requestedSelection = input.requestedSelection
    ? normalizeMissionTeamRoleSelection(input.requestedSelection)
    : undefined;
  const explicitSelection = Boolean(requestedSelection);
  const fixedSelection = requestedSelection?.mode === 'fixed';
  const blockedReasons = new Set<string>();
  const hardExcludedAgents = new Set(
    (separation?.excludeAgents || []).filter((entry): entry is string => Boolean(entry))
  );
  const softAvoidAgents = new Set(
    (separation?.avoidAgents || []).filter((entry): entry is string => Boolean(entry))
  );
  const softAvoidProviders = new Set(
    (separation?.avoidProviders || []).filter((entry): entry is string => Boolean(entry))
  );
  const requiredCapabilities = new Set(
    (teamRoleRecord.required_capabilities || [])
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  const selectionHints = resolveTeamRoleSelectionHints(teamRoleRecord);
  const preferredAgents = new Set(selectionHints.preferred_agents);
  const preferredModels = new Set(selectionHints.preferred_models);
  // The KD-05 tier this role's delegation must run under — providers that
  // cannot project it are excluded during candidacy, not just at dispatch.
  const requiredTier = resolveCapabilityProfileForTeamRole(teamRole);
  const candidates = Object.entries(agents)
    .flatMap(([agentId, profile]) => {
      if (!profile.team_roles.includes(teamRole)) return [];
      if (fixedSelection && requestedSelection?.agent_id && requestedSelection.agent_id !== agentId)
        return [];
      if (explicitSelection && hardExcludedAgents.has(agentId)) {
        blockedReasons.add('Requested actor is excluded by review independence.');
        return [];
      }

      const profileCapabilities = new Set(
        (profile.capabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
      );
      if (
        explicitSelection &&
        !Array.from(requiredCapabilities).every((capability) => profileCapabilities.has(capability))
      ) {
        blockedReasons.add('Actor does not hold every required capability.');
        return [];
      }
      const routedModelId = routingHint?.model_id;
      const routedProvider = routedModelId ? resolveModelProvider(routedModelId) : undefined;
      const agentSelectionHints = providerPreference?.provider
        ? {
            ...profile.selection_hints,
            preferred_provider: providerPreference.provider,
            ...(providerPreference.modelId
              ? { preferred_modelId: providerPreference.modelId }
              : {}),
          }
        : profile.selection_hints;
      const providerConfig = loadProviderConfig();
      const fallbackProvider =
        providerPreference?.provider ||
        profile.selection_hints?.preferred_provider ||
        routedProvider ||
        providerConfig.default_priority[0] ||
        'claude';
      const fallbackModel =
        providerPreference?.modelId ||
        profile.selection_hints?.preferred_modelId ||
        selectionHints.preferred_models[0] ||
        routedModelId ||
        providerConfig.default_models[fallbackProvider];
      const { provider: selectionProvider, modelId: selectionModel } = resolveSelectionHints(
        agentSelectionHints,
        fallbackProvider as any,
        fallbackModel,
        agentId
      );
      let resolvedTarget: ResolvedAgentProviderTarget;
      let projectionFallback: { from: string; tier: string } | undefined;
      try {
        resolvedTarget = resolveAgentProviderTarget(
          {
            preferredProvider: requestedSelection?.provider || selectionProvider,
            preferredModelId: requestedSelection?.model_id || selectionModel,
            providerStrategy:
              providerPreference?.strategy || profile.provider_strategy || 'adaptive',
            fallbackProviders: profile.fallback_providers || [],
            requiredCapabilities: explicitSelection
              ? Array.from(requiredCapabilities)
              : profile.capabilities,
            ...(requestedSelection
              ? {
                  selectionMode: requestedSelection.mode,
                  ...(fixedSelection
                    ? {
                        fixedProvider: requestedSelection.provider,
                        fixedModelId: requestedSelection.model_id,
                      }
                    : {}),
                }
              : {}),
          },
          discoveredProviders
        );
      } catch (error) {
        if (!explicitSelection) throw error;
        blockedReasons.add(error instanceof Error ? error.message : String(error));
        return [];
      }
      if (explicitSelection && resolvedTarget.strategy === 'unresolved') {
        blockedReasons.add('No available provider/model satisfies the requested selection.');
        return [];
      }
      // Capability-projection candidacy: a provider that cannot structurally
      // project this team role's KD-05 tier must not win this slot — but the
      // candidate is only dropped when no fallback provider can either. A
      // fixed/requested provider that cannot project is never substituted.
      if (
        resolvedTarget.provider &&
        !(
          requestedSelection?.execution_route === 'agent_runtime' &&
          canProvideGovernedTaskTools(resolvedTarget.provider)
        ) &&
        !providerCanProjectProfile(resolvedTarget.provider, requiredTier)
      ) {
        const failedProvider = resolvedTarget.provider;
        if (fixedSelection || explicitSelection) {
          blockedReasons.add(
            `Provider "${failedProvider}" cannot project the "${requiredTier}" capability tier.`
          );
          return [];
        }
        const alternates = [
          ...new Set(
            [...(profile.fallback_providers || []), ...providerConfig.default_priority].filter(
              (alt): alt is string =>
                typeof alt === 'string' && alt !== failedProvider && alt !== resolvedTarget.provider
            )
          ),
        ];
        let recovered = false;
        for (const alt of alternates) {
          if (!providerCanProjectProfile(alt, requiredTier)) continue;
          try {
            const retry = resolveAgentProviderTarget(
              {
                preferredProvider: alt,
                preferredModelId: undefined,
                providerStrategy:
                  providerPreference?.strategy || profile.provider_strategy || 'adaptive',
                fallbackProviders: [],
                requiredCapabilities: profile.capabilities,
              },
              discoveredProviders
            );
            if (retry.provider && retry.strategy !== 'unresolved') {
              resolvedTarget = retry;
              recovered = true;
              break;
            }
          } catch {
            // Try the next alternate; resolution failures here are not fatal.
          }
        }
        if (recovered) projectionFallback = { from: failedProvider, tier: requiredTier };
        if (!recovered) {
          blockedReasons.add(
            `No provider can project the "${requiredTier}" capability tier for this candidate.`
          );
          return [];
        }
      }
      const capabilityHits = Array.from(requiredCapabilities).filter((capability) =>
        profileCapabilities.has(capability)
      ).length;
      const capabilityPenalty = Math.max(0, requiredCapabilities.size - capabilityHits) * 2;
      const preferredAgentBonus = preferredAgents.has(agentId.toLowerCase()) ? 20 : 0;
      const preferredModelBonus = selectedModelHasHint(resolvedTarget.modelId, preferredModels)
        ? 5
        : 0;
      const providerBonus = selectionProvider === resolvedTarget.provider ? 2 : 0;
      // Retrospective feedback: measured agent×role outcomes adjust the
      // score within ±8 (operator preferred_agents bonus of 20 still wins).
      const performanceBonus = performanceScoreAdjustment(agentId, teamRole);
      const modelPerformanceBonus = modelPerformanceScoreAdjustment(
        resolvedTarget.modelId,
        teamRole
      );
      // TC-16: measured role fitness speaks only while real outcomes are
      // silent — the cold start every new model and provider goes through.
      const modelFitnessBonus = modelRoleFitnessScoreAdjustment(resolvedTarget.modelId, teamRole);
      const separationPenalty =
        (softAvoidAgents.has(agentId) ? SOD_AVOID_AGENT_PENALTY : 0) +
        (softAvoidProviders.has(resolvedTarget.provider) ? SOD_AVOID_PROVIDER_PENALTY : 0);
      // TC-09: observed load, scored by the shared worker-assignment policy so
      // one module owns what "busy" costs a candidate.
      const loadPenalty = loadIndex
        ? workerLoadPenalty(resolveWorkforceLoad(agentId, loadIndex))
        : 0;
      const requestedMatch =
        requestedSelection?.mode === 'preferred' &&
        (!requestedSelection.agent_id || requestedSelection.agent_id === agentId) &&
        (!requestedSelection.provider || requestedSelection.provider === resolvedTarget.provider) &&
        (!requestedSelection.model_id || requestedSelection.model_id === resolvedTarget.modelId);
      const score =
        (requestedMatch ? 1000000 : 0) +
        capabilityHits * 10 -
        capabilityPenalty +
        preferredAgentBonus +
        preferredModelBonus +
        providerBonus +
        performanceBonus +
        modelPerformanceBonus +
        modelFitnessBonus -
        separationPenalty -
        loadPenalty;

      const requiredScopes = new Set(teamRoleRecord.required_scope_classes || []);
      const compatibleAuthorityRoles = profile.authority_roles.filter((role) =>
        teamRoleRecord.compatible_authority_roles.includes(role)
      );
      return compatibleAuthorityRoles.flatMap((authorityRole) => {
        const authorityRecord = authorityRoles[authorityRole];
        if (!authorityRecord) return [];
        if (explicitSelection && input.tier && !authorityRecord.tier_access.includes(input.tier))
          return [];
        const resolvedScopes = new Set(authorityRecord.scope_classes || []);
        const missingScope = Array.from(requiredScopes).find(
          (scopeClass) => !resolvedScopes.has(scopeClass)
        );
        if (missingScope) return [];
        return [
          {
            agentId,
            profile,
            authorityRole,
            authorityRecord,
            resolvedTarget,
            score,
            ...(projectionFallback ? { projectionFallback } : {}),
          } satisfies SelectionCandidate,
        ];
      });
    })
    .filter((entry): entry is SelectionCandidate => Boolean(entry))
    .sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));

  // Hard SoD exclusion: prefer any independent candidate; only when the pool
  // has no alternative does the excluded actor win (a staffed role with a
  // recorded SoD gap beats an unstaffed role).
  const independentWinner = candidates.find(
    (candidate) => !hardExcludedAgents.has(candidate.agentId)
  );
  const winner = independentWinner || (explicitSelection ? undefined : candidates[0]);
  const separationFallback = Boolean(winner && !independentWinner && hardExcludedAgents.size > 0);
  if (winner) {
    const matchesRequested =
      !requestedSelection ||
      ((!requestedSelection.agent_id || requestedSelection.agent_id === winner.agentId) &&
        (!requestedSelection.provider ||
          requestedSelection.provider === winner.resolvedTarget.provider) &&
        (!requestedSelection.model_id ||
          requestedSelection.model_id === winner.resolvedTarget.modelId));
    return {
      ...(requestedSelection
        ? {
            requested_selection: requestedSelection,
            selection_resolution: {
              source:
                requestedSelection.mode === 'auto'
                  ? ('auto' as const)
                  : matchesRequested
                    ? ('requested' as const)
                    : ('fallback' as const),
              reason:
                requestedSelection.mode === 'auto'
                  ? 'Automatically selected an eligible actor and execution target.'
                  : matchesRequested
                    ? 'Requested dimensions selected after capability, authority, scope and independence checks.'
                    : 'Preferred dimensions unavailable or ineligible; selected an eligible fallback.',
            },
          }
        : {}),
      team_role: teamRole,
      required: true,
      status: 'assigned',
      agent_id: winner.agentId,
      ...(winner.profile.instance_of
        ? {
            instance_of: winner.profile.instance_of,
            instance_index: winner.profile.instance_index,
          }
        : {}),
      // NI-01: canonical durable-identity name for the selected agent
      // (kyberion://agent/<org>/<slug>). Pure derivation — the provisioned
      // ledger record is ensured downstream at staffing/spawn time.
      runtime_identity: deriveAgentNhiId(winner.agentId, organizationId),
      authority_role: winner.authorityRole,
      delegation_contract: {
        ownership_scope: teamRoleRecord.ownership_scope,
        allowed_delegate_team_roles: teamRoleRecord.allowed_delegate_team_roles,
        escalation_parent_team_role: teamRoleRecord.escalation_parent_team_role,
        required_scope_classes: teamRoleRecord.required_scope_classes,
        resolved_scope_classes: winner.authorityRecord.scope_classes || [],
        allowed_write_scopes: winner.authorityRecord.write_scopes || [],
      },
      provider: winner.resolvedTarget.provider,
      modelId: winner.resolvedTarget.modelId,
      required_capabilities: teamRoleRecord.required_capabilities,
      notes: `${teamRoleRecord.autonomy_level} autonomy; capability-first match (${winner.resolvedTarget.strategy})${
        separationFallback
          ? '; WARNING separation-of-duties fallback — no independent actor available'
          : ''
      }${
        winner.projectionFallback
          ? `; capability-tier fallback — ${winner.projectionFallback.from} cannot project ${winner.projectionFallback.tier}`
          : ''
      }`,
    };
  }

  return {
    ...(requestedSelection
      ? {
          requested_selection: requestedSelection,
          selection_resolution: {
            source: 'blocked' as const,
            reason:
              Array.from(blockedReasons).join(' ') ||
              'No actor satisfies the requested identity, capabilities, compatible authority, scope and independence constraints.',
          },
        }
      : {}),
    team_role: teamRole,
    required: true,
    status: 'unfilled',
    agent_id: null,
    authority_role: null,
    delegation_contract: null,
    provider: null,
    modelId: null,
    required_capabilities: teamRoleRecord.required_capabilities,
    notes: 'No compatible agent profile found for this team role',
  };
}
