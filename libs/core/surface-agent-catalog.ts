import * as path from 'node:path';
import { loadAgentManifests, resolveAgentSelectionHints, type AgentManifest } from './agent-manifest.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

export interface SurfaceAgentCatalogEntry {
  agentId: string;
  displayName: string;
  provider: string;
  modelId: string;
  capabilities: string[];
  authorityRoles: string[];
  teamRoles: string[];
  allowedActuators: string[];
  deniedActuators: string[];
  summary: string;
  responsibilities: string[];
  nonResponsibilities: string[];
  delegationTargets: string[];
}

interface AgentProfileIndexEntry {
  authority_roles?: string[];
  team_roles?: string[];
  capabilities?: string[];
  selection_hints?: {
    preferred_provider?: string;
    preferred_modelId?: string;
  };
}

interface AgentProfileIndex {
  agents?: Record<string, AgentProfileIndexEntry>;
}

const AGENT_PROFILE_INDEX_PATH = pathResolver.knowledge('public/orchestration/agent-profile-index.json');

function titleCaseAgentId(agentId: string): string {
  return agentId
    .split('-')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
}

function parseFrontmatterBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match?.[1] || content).trim();
}

function collectBulletsFromSection(body: string, headings: string[]): string[] {
  const lines = body.split('\n');
  const normalizedHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  let capture = false;
  const items: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+/.test(line)) {
      const heading = line.replace(/^#{1,6}\s+/, '').trim().toLowerCase();
      capture = normalizedHeadings.has(heading);
      continue;
    }
    if (!capture) continue;
    if (line.startsWith('- ')) {
      items.push(line.slice(2).trim());
      continue;
    }
    if (line.length > 0 && !line.startsWith('```') && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line}`.trim();
    }
  }
  return items;
}

function extractSummary(body: string): string {
  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('- ') || line.startsWith('```')) continue;
    return line;
  }
  return '';
}

function extractDelegationTargets(body: string): string[] {
  const matches = [...body.matchAll(/`([a-z][a-z0-9-]+)`/g)];
  const targets = new Set<string>();
  for (const match of matches) {
    const value = match[1];
    if (value.endsWith('-agent') || value.includes('mirror') || value.includes('gateway')) {
      targets.add(value);
    }
  }
  return [...targets];
}

function loadAgentProfileIndex(): Record<string, AgentProfileIndexEntry> {
  if (!safeExistsSync(AGENT_PROFILE_INDEX_PATH)) return {};
  const raw = safeReadFile(AGENT_PROFILE_INDEX_PATH, { encoding: 'utf8' }) as string;
  const parsed = safeJsonParse<AgentProfileIndex>(raw, 'agent profile index');
  return parsed.agents || {};
}

function isSurfaceAgent(manifest: AgentManifest, profile?: AgentProfileIndexEntry): boolean {
  const manifestCaps = new Set(manifest.capabilities || []);
  const profileRoles = new Set(profile?.team_roles || []);
  return (
    manifestCaps.has('surface') ||
    manifestCaps.has('presence') ||
    manifestCaps.has('dashboard') ||
    profileRoles.has('surface_liaison')
  );
}

function loadAgentBody(agentId: string): string {
  const filePath = path.join(pathResolver.knowledge('agents'), `${agentId}.agent.md`);
  if (!safeExistsSync(filePath)) return '';
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return parseFrontmatterBody(raw);
}

export function listSurfaceAgentCatalog(): SurfaceAgentCatalogEntry[] {
  const manifests = loadAgentManifests(pathResolver.rootDir());
  const profileIndex = loadAgentProfileIndex();

  return manifests
    .filter((manifest) => isSurfaceAgent(manifest, profileIndex[manifest.agentId]))
    .map((manifest) => {
      const profile = profileIndex[manifest.agentId] || {};
      const body = loadAgentBody(manifest.agentId);
      let selectionProvider: string;
      let selectionModel: string;
      try {
        const resolved = resolveAgentSelectionHints(manifest);
        selectionProvider = resolved.provider;
        selectionModel = resolved.modelId;
      } catch {
        return null;
      }
      return {
        agentId: manifest.agentId,
        displayName: body.match(/^#\s+(.+)$/m)?.[1]?.trim() || titleCaseAgentId(manifest.agentId),
        provider: selectionProvider,
        modelId: selectionModel,
        capabilities: profile.capabilities || manifest.capabilities || [],
        authorityRoles: profile.authority_roles || [],
        teamRoles: profile.team_roles || [],
        allowedActuators: manifest.allowedActuators || [],
        deniedActuators: manifest.deniedActuators || [],
        summary: extractSummary(body),
        responsibilities: collectBulletsFromSection(body, ['Responsibilities', 'Role', 'Behavior']),
        nonResponsibilities: collectBulletsFromSection(body, ['Non-responsibilities', 'Rules', 'Response Rules']),
        delegationTargets: extractDelegationTargets(body),
      };
    })
    .filter((entry): entry is SurfaceAgentCatalogEntry => Boolean(entry))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export function getSurfaceAgentCatalogEntry(agentId?: string): SurfaceAgentCatalogEntry | null {
  if (!agentId) return null;
  return listSurfaceAgentCatalog().find((entry) => entry.agentId === agentId) || null;
}
