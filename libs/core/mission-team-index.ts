import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import type { AuthorityRoleRecord, AgentProfileRecord, TeamRoleRecord } from './team-role-assignment-selection.js';

interface MissionTeamTemplate {
  required_roles: string[];
  optional_roles: string[];
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

export function loadAgentProfileDirectory(rootDir?: string): Record<string, AgentProfileRecord> | null {
  const dir = rootDir
    ? path.join(rootDir, 'knowledge', 'public', 'orchestration', 'agent-profiles')
    : pathResolver.knowledge('public/orchestration/agent-profiles');
  if (!safeExistsSync(dir)) return null;

  const profiles: Record<string, AgentProfileRecord> = {};
  const files = safeReaddir(dir).filter((entry) => entry.endsWith('.json')).sort();
  for (const file of files) {
    const fullPath = rootDir
      ? path.join(rootDir, 'knowledge', 'public', 'orchestration', 'agent-profiles', file)
      : pathResolver.knowledge(`public/orchestration/agent-profiles/${file}`);
    const payload = loadJson<{ version?: string; agents?: Record<string, AgentProfileRecord> }>(fullPath);
    const agentIds = Object.keys(payload.agents || {});
    if (agentIds.length !== 1) {
      throw new Error(`Agent profile file ${file} must contain exactly one agent profile`);
    }
    const agentId = agentIds[0];
    if (agentId !== file.replace(/\.json$/i, '')) {
      throw new Error(`Agent profile file ${file} must match its agent id (${agentId})`);
    }
    profiles[agentId] = payload.agents![agentId];
  }

  return Object.keys(profiles).length > 0 ? profiles : null;
}

export function loadAgentProfileSnapshot(rootDir?: string): Record<string, AgentProfileRecord> {
  const index = loadJson<{ agents: Record<string, AgentProfileRecord> }>(
    rootDir
      ? path.join(rootDir, 'knowledge', 'public', 'orchestration', 'agent-profile-index.json')
      : pathResolver.knowledge('public/orchestration/agent-profile-index.json'),
  );
  return index.agents;
}

export function loadAuthorityRoleIndex(): Record<string, AuthorityRoleRecord> {
  const directory = pathResolver.knowledge('public/governance/authority-roles');
  if (safeExistsSync(directory)) {
    const roles: Record<string, AuthorityRoleRecord> = {};
    const files = safeReaddir(directory).filter((entry) => entry.endsWith('.json')).sort();
    if (files.length > 0) {
      for (const file of files) {
        const payload = loadJson<{ role?: string; [key: string]: unknown }>(
          pathResolver.knowledge(`public/governance/authority-roles/${file}`),
        );
        const role = String(payload.role || '').trim();
        if (!role) {
          throw new Error(`Authority role file ${file} must declare a role id`);
        }
        if (role !== file.replace(/\.json$/i, '')) {
          throw new Error(`Authority role file ${file} must match its role id (${role})`);
        }
        const { role: _role, ...record } = payload as { role?: string; [key: string]: unknown };
        roles[role] = record as unknown as AuthorityRoleRecord;
      }
      return roles;
    }
  }

  const index = loadJson<{ authority_roles: Record<string, AuthorityRoleRecord> }>(
    pathResolver.knowledge('public/governance/authority-role-index.json'),
  );
  return index.authority_roles;
}

export function loadTeamRoleDirectory(): Record<string, TeamRoleRecord> | null {
  const dir = pathResolver.knowledge('public/orchestration/team-roles');
  if (!safeExistsSync(dir)) return null;

  const roles: Record<string, TeamRoleRecord> = {};
  const files = safeReaddir(dir).filter((entry) => entry.endsWith('.json')).sort();
  for (const file of files) {
    const payload = loadJson<{ role?: string; [key: string]: unknown }>(
      pathResolver.knowledge(`public/orchestration/team-roles/${file}`),
    );
    const role = String(payload.role || '').trim();
    if (!role) {
      throw new Error(`Team role file ${file} must declare a role id`);
    }
    if (role !== file.replace(/\.json$/i, '')) {
      throw new Error(`Team role file ${file} must match its role id (${role})`);
    }
    const { role: _role, ...record } = payload as { role?: string; [key: string]: unknown };
    roles[role] = record as unknown as TeamRoleRecord;
  }

  return Object.keys(roles).length > 0 ? roles : null;
}

export function loadTeamRoleSnapshot(): Record<string, TeamRoleRecord> {
  const index = loadJson<{ team_roles: Record<string, TeamRoleRecord> }>(
    pathResolver.knowledge('public/orchestration/team-role-index.json'),
  );
  return index.team_roles;
}

export function loadTeamRoleIndex(): Record<string, TeamRoleRecord> {
  return loadTeamRoleDirectory() || loadTeamRoleSnapshot();
}

export function loadAgentProfileIndex(rootDir?: string): Record<string, AgentProfileRecord> {
  const directoryProfiles = loadAgentProfileDirectory(rootDir);
  if (directoryProfiles) return directoryProfiles;
  return loadAgentProfileSnapshot(rootDir);
}

export function loadMissionTeamTemplates(): Record<string, MissionTeamTemplate> {
  const index = loadJson<{ templates: Record<string, MissionTeamTemplate> }>(
    pathResolver.knowledge('public/orchestration/mission-team-templates.json'),
  );
  return index.templates;
}
