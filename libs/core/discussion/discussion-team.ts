import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { readJsonIfPresent } from '../foundation/json.js';
import { loadDiscussionCopy } from './discussion-copy.js';
import type { DiscussionParticipant } from './discussion-types.js';

interface TeamRoleFile {
  role: string;
  description?: string;
  required_capabilities?: string[];
  selection_hints?: { preferred_agents?: string[] };
}

interface AgentProfile {
  team_roles?: string[];
  capabilities?: string[];
}

export interface DiscussionTeamPlan {
  participants: DiscussionParticipant[];
  gaps: string[];
}

/** Roles a deliberation always needs, then goal-driven discretionary seats. */
const CORE_ROLES = ['facilitator', 'researcher', 'devils_advocate', 'scribe'] as const;

const MAX_TEAM_SIZE = 6;

function readJson<T>(filePath: string): T | null {
  try {
    return readJsonIfPresent<T>(filePath);
  } catch {
    return null;
  }
}

function loadTeamRoles(): Map<string, TeamRoleFile> {
  const dir = pathResolver.knowledge('product/orchestration/team-roles');
  const roles = new Map<string, TeamRoleFile>();
  if (!safeExistsSync(dir)) return roles;
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json') || name === 'team-role-index.json') continue;
    const role = readJson<TeamRoleFile>(path.join(dir, name));
    if (role?.role) roles.set(role.role, role);
  }
  return roles;
}

function loadAgentProfiles(): Map<string, AgentProfile> {
  const dir = pathResolver.knowledge('product/orchestration/agent-profiles');
  const agents = new Map<string, AgentProfile>();
  if (!safeExistsSync(dir)) return agents;
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json') || name === 'agent-profile-index.json') continue;
    const file = readJson<{ agents?: Record<string, AgentProfile> }>(path.join(dir, name));
    for (const [id, profile] of Object.entries(file?.agents ?? {})) agents.set(id, profile);
  }
  return agents;
}

function displayName(agentId: string): string {
  return agentId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface Candidate {
  agentId: string;
  score: number;
  fit: number;
  rationale: string;
  capabilities: string[];
}

function rankCandidates(
  role: TeamRoleFile,
  roleId: string,
  agents: Map<string, AgentProfile>,
  used: Map<string, number>
): Candidate[] {
  const required = role.required_capabilities ?? [];
  const preferred = new Set(role.selection_hints?.preferred_agents ?? []);
  const candidates: Candidate[] = [];
  for (const [agentId, profile] of agents) {
    const staffsRole = (profile.team_roles ?? []).includes(roleId);
    if (!staffsRole && !preferred.has(agentId)) continue;
    const capabilities = profile.capabilities ?? [];
    const matched = required.filter((cap) => capabilities.includes(cap));
    const capabilityFit = required.length === 0 ? 1 : matched.length / required.length;
    if (capabilityFit === 0 && !preferred.has(agentId)) continue;
    // Separation of duties: prefer agents not already seated in this room.
    const reuse = used.get(agentId) ?? 0;
    const score =
      capabilityFit * 10 + (preferred.has(agentId) ? 4 : 0) + (staffsRole ? 2 : 0) - reuse * 3;
    const reasons = [
      required.length
        ? `capability ${matched.length}/${required.length}`
        : 'no required capability',
      preferred.has(agentId) ? 'preferred agent for role' : undefined,
      staffsRole ? 'profile declares role' : undefined,
      reuse ? `already seated ${reuse}x (penalized)` : undefined,
    ].filter(Boolean);
    candidates.push({
      agentId,
      score,
      fit: Math.max(0.1, Math.min(1, capabilityFit * 0.8 + (preferred.has(agentId) ? 0.2 : 0))),
      rationale: reasons.join(' / '),
      capabilities: capabilities.slice(0, 6),
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
}

/**
 * Compose a discussion team from the organization's agent pool. Selection is
 * deterministic (capability match + preferred-agent hints + separation of
 * duties), so a room's roster is reproducible from its goal.
 */
export function composeDiscussionTeam(goal: string): DiscussionTeamPlan {
  const roles = loadTeamRoles();
  const agents = loadAgentProfiles();
  const used = new Map<string, number>();
  const wanted: string[] = [...CORE_ROLES];
  for (const { role, keywords } of loadDiscussionCopy().discretionary_roles) {
    if (wanted.length >= MAX_TEAM_SIZE) break;
    if (new RegExp(keywords, 'iu').test(goal)) wanted.push(role);
  }
  // Always keep a second substantive voice besides the devil's advocate.
  if (wanted.length < 5) wanted.splice(3, 0, wanted.includes('planner') ? 'reviewer' : 'planner');

  const participants: DiscussionParticipant[] = [];
  const gaps: string[] = [];
  for (const roleId of [...new Set(wanted)]) {
    const role = roles.get(roleId);
    if (!role) {
      gaps.push(`${roleId}: role definition not found`);
      continue;
    }
    const [best] = rankCandidates(role, roleId, agents, used);
    if (!best) {
      gaps.push(`${roleId}: no compatible agent in the pool`);
      continue;
    }
    used.set(best.agentId, (used.get(best.agentId) ?? 0) + 1);
    participants.push({
      id: roleId,
      agent_id: best.agentId,
      role: roleId,
      name: displayName(best.agentId),
      rationale: best.rationale,
      fit: Number(best.fit.toFixed(2)),
      capabilities: best.capabilities,
    });
  }
  return { participants, gaps };
}
