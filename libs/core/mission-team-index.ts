import { safeReadFile } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import type { AuthorityRoleRecord, AgentProfileRecord, TeamRoleRecord } from './team-role-assignment-selection.js';

interface MissionTeamTemplate {
  required_roles: string[];
  optional_roles: string[];
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function loadAuthorityRoleIndex(): Record<string, AuthorityRoleRecord> {
  const index = loadJson<{ authority_roles: Record<string, AuthorityRoleRecord> }>(
    pathResolver.knowledge('public/governance/authority-role-index.json'),
  );
  return index.authority_roles;
}

export function loadTeamRoleIndex(): Record<string, TeamRoleRecord> {
  const index = loadJson<{ team_roles: Record<string, TeamRoleRecord> }>(
    pathResolver.knowledge('public/orchestration/team-role-index.json'),
  );
  return index.team_roles;
}

export function loadAgentProfileIndex(): Record<string, AgentProfileRecord> {
  const index = loadJson<{ agents: Record<string, AgentProfileRecord> }>(
    pathResolver.knowledge('public/orchestration/agent-profile-index.json'),
  );
  return index.agents;
}

export function loadMissionTeamTemplates(): Record<string, MissionTeamTemplate> {
  const index = loadJson<{ templates: Record<string, MissionTeamTemplate> }>(
    pathResolver.knowledge('public/orchestration/mission-team-templates.json'),
  );
  return index.templates;
}
