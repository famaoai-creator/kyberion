import { resolveAgentProviderTarget, type ResolvedAgentProviderTarget } from './agent-provider-resolution.js';
import { resolveSelectionHints } from './agent-manifest.js';
import { resolveTeamRoleSelectionHints } from './team-role-selection.js';

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
}

export interface MissionTeamAssignment {
  team_role: string;
  required: boolean;
  status: 'assigned' | 'unfilled';
  agent_id: string | null;
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
}

interface SelectionCandidate {
  agentId: string;
  authorityRole: string;
  authorityRecord: AuthorityRoleRecord;
  resolvedTarget: ResolvedAgentProviderTarget;
  score: number;
}

function selectedModelHasHint(modelId: string, preferredModels: Set<string>): boolean {
  return preferredModels.has(String(modelId || '').trim().toLowerCase());
}

export function selectAgentForTeamRole(
  teamRole: string,
  teamRoleRecord: TeamRoleRecord,
  authorityRoles: Record<string, AuthorityRoleRecord>,
  agents: Record<string, AgentProfileRecord>,
): MissionTeamAssignment {
  const requiredCapabilities = new Set((teamRoleRecord.required_capabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const selectionHints = resolveTeamRoleSelectionHints(teamRoleRecord);
  const preferredAgents = new Set(selectionHints.preferred_agents);
  const preferredModels = new Set(selectionHints.preferred_models);
  const candidates = Object.entries(agents)
    .map(([agentId, profile]) => {
      if (!profile.team_roles.includes(teamRole)) return null;
      const authorityRole = profile.authority_roles.find((role) =>
        teamRoleRecord.compatible_authority_roles.includes(role),
      );
      if (!authorityRole) return null;
      const authorityRecord = authorityRoles[authorityRole];
      if (!authorityRecord) return null;
      const requiredScopes = new Set(teamRoleRecord.required_scope_classes || []);
      const resolvedScopes = new Set(authorityRecord.scope_classes || []);
      const missingScope = Array.from(requiredScopes).find((scopeClass) => !resolvedScopes.has(scopeClass));
      if (missingScope) return null;

      const profileCapabilities = new Set((profile.capabilities || []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));

      const { provider: selectionProvider, modelId: selectionModel } = resolveSelectionHints(
        profile.selection_hints,
        undefined,
        selectionHints.preferred_models[0],
        agentId,
      );
      const resolvedTarget = resolveAgentProviderTarget({
        preferredProvider: selectionProvider,
        preferredModelId: selectionModel,
        providerStrategy: profile.provider_strategy || 'adaptive',
        fallbackProviders: profile.fallback_providers || [],
        requiredCapabilities: profile.capabilities,
      });
      const capabilityHits = Array.from(requiredCapabilities).filter((capability) => profileCapabilities.has(capability)).length;
      const capabilityPenalty = Math.max(0, requiredCapabilities.size - capabilityHits) * 2;
      const preferredAgentBonus = preferredAgents.has(agentId.toLowerCase()) ? 20 : 0;
      const preferredModelBonus = selectedModelHasHint(resolvedTarget.modelId, preferredModels) ? 5 : 0;
      const providerBonus = selectionProvider === resolvedTarget.provider ? 2 : 0;
      const score = capabilityHits * 10 - capabilityPenalty + preferredAgentBonus + preferredModelBonus + providerBonus;

      return {
        agentId,
        authorityRole,
        authorityRecord,
        resolvedTarget,
        score,
      } satisfies SelectionCandidate;
    })
    .filter((entry): entry is SelectionCandidate => Boolean(entry))
    .sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));

  const winner = candidates[0];
  if (winner) {
    return {
      team_role: teamRole,
      required: true,
      status: 'assigned',
      agent_id: winner.agentId,
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
      notes: `${teamRoleRecord.autonomy_level} autonomy; capability-first match (${winner.resolvedTarget.strategy})`,
    };
  }

  return {
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
