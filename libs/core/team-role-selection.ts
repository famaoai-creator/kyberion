export interface TeamRoleSelectionHints {
  preferred_agents: string[];
  preferred_models: string[];
}

export interface TeamRoleSelectionSource {
  selection_hints?: {
    preferred_agents?: string[];
    preferred_models?: string[];
  };
}

export function resolveTeamRoleSelectionHints(source: TeamRoleSelectionSource): TeamRoleSelectionHints {
  return {
    preferred_agents: (source.selection_hints?.preferred_agents || [])
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    preferred_models: (source.selection_hints?.preferred_models || [])
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  };
}
