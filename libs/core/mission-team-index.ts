import { loadJson, safeExistsSync, safeReaddir } from './secure-io.js';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import type { OrganizationProfile } from './organization-profile.js';
import type {
  AuthorityRoleRecord,
  AgentProfileRecord,
  TeamRoleRecord,
} from './team-role-assignment-selection.js';

interface MissionTeamTemplate {
  required_roles: string[];
  optional_roles: string[];
  lifecycle?: {
    max_parallel_members: number;
    max_members: number;
    max_messages_per_run: number;
    max_wall_clock_minutes: number;
    max_member_turns: number;
    shutdown_policy: 'graceful_handoff' | 'manual' | 'auto_shutdown';
    resume_policy: 'checkpoint_resume' | 'manual_resume';
    cooldown_minutes: number;
  };
}

interface OrganizationMissionTeamTemplateCatalog {
  version: string;
  organization_id?: string;
  templates: Record<string, Partial<MissionTeamTemplate>>;
}

export interface OrganizationMissionTeamTemplateCatalogSummary {
  organization_id: string;
  catalog_id: string;
  template_ids: string[];
  template_count: number;
  optional_role_count: number;
  required_role_count: number;
}

export interface OrganizationMissionTeamTemplateCatalogSelectionSummary extends OrganizationMissionTeamTemplateCatalogSummary {
  selected: boolean;
}

export function resolveOrganizationMissionTeamTemplateCatalogId(
  organizationProfile?: OrganizationProfile | null
): string | null {
  const catalogId = organizationProfile?.team_defaults?.team_template_catalog_id?.trim();
  return catalogId || null;
}

function mergeMissionTeamTemplate(
  base: MissionTeamTemplate,
  overlay: Partial<MissionTeamTemplate>
): MissionTeamTemplate {
  return {
    ...base,
    ...overlay,
    required_roles: overlay.required_roles ? [...overlay.required_roles] : [...base.required_roles],
    optional_roles: overlay.optional_roles ? [...overlay.optional_roles] : [...base.optional_roles],
    lifecycle: {
      ...(base.lifecycle || ({} as NonNullable<MissionTeamTemplate['lifecycle']>)),
      ...(overlay.lifecycle || {}),
    },
  };
}

export function loadAgentProfileDirectory(
  rootDir?: string
): Record<string, AgentProfileRecord> | null {
  const dir = rootDir
    ? path.join(rootDir, 'knowledge', 'product', 'orchestration', 'agent-profiles')
    : pathResolver.knowledge('product/orchestration/agent-profiles');
  if (!safeExistsSync(dir)) return null;

  const profiles: Record<string, AgentProfileRecord> = {};
  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  for (const file of files) {
    const fullPath = rootDir
      ? path.join(rootDir, 'knowledge', 'product', 'orchestration', 'agent-profiles', file)
      : pathResolver.knowledge(`product/orchestration/agent-profiles/${file}`);
    const payload = loadJson<{ version?: string; agents?: Record<string, AgentProfileRecord> }>(
      fullPath
    );
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
      ? path.join(rootDir, 'knowledge', 'product', 'orchestration', 'agent-profile-index.json')
      : pathResolver.knowledge('product/orchestration/agent-profile-index.json')
  );
  return index.agents;
}

export function loadAuthorityRoleIndex(): Record<string, AuthorityRoleRecord> {
  const directory = pathResolver.knowledge('product/governance/authority-roles');
  if (safeExistsSync(directory)) {
    const roles: Record<string, AuthorityRoleRecord> = {};
    const files = safeReaddir(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    if (files.length > 0) {
      for (const file of files) {
        const payload = loadJson<{ role?: string; [key: string]: unknown }>(
          pathResolver.knowledge(`product/governance/authority-roles/${file}`)
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
    pathResolver.knowledge('product/governance/authority-role-index.json')
  );
  return index.authority_roles;
}

export function loadTeamRoleDirectory(): Record<string, TeamRoleRecord> | null {
  const dir = pathResolver.knowledge('product/orchestration/team-roles');
  if (!safeExistsSync(dir)) return null;

  const roles: Record<string, TeamRoleRecord> = {};
  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  for (const file of files) {
    const payload = loadJson<{ role?: string; [key: string]: unknown }>(
      pathResolver.knowledge(`product/orchestration/team-roles/${file}`)
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
    pathResolver.knowledge('product/orchestration/team-role-index.json')
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

export function loadMissionTeamTemplates(
  organizationProfile?: OrganizationProfile | null
): Record<string, MissionTeamTemplate> {
  const index = loadJson<{ templates: Record<string, MissionTeamTemplate> }>(
    pathResolver.knowledge('product/orchestration/mission-team-templates.json')
  );
  const templates = { ...index.templates };
  const catalogId = resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile);
  if (!catalogId) return templates;

  const catalogPath = pathResolver.knowledge(
    `product/governance/organization-team-template-catalogs/${catalogId}.json`
  );
  if (!safeExistsSync(catalogPath)) return templates;

  const catalog = loadJson<OrganizationMissionTeamTemplateCatalog>(catalogPath);
  for (const [templateId, overlay] of Object.entries(catalog.templates || {})) {
    const base = templates[templateId] || templates.default;
    if (!base) continue;
    templates[templateId] = mergeMissionTeamTemplate(base, overlay);
  }
  return templates;
}

export function listOrganizationMissionTeamTemplateCatalogSummaries(): OrganizationMissionTeamTemplateCatalogSummary[] {
  const catalogDir = pathResolver.knowledge(
    'product/governance/organization-team-template-catalogs'
  );
  if (!safeExistsSync(catalogDir)) return [];

  return safeReaddir(catalogDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((file) => {
      const catalogPath = pathResolver.knowledge(
        `product/governance/organization-team-template-catalogs/${file}`
      );
      const payload = loadJson<OrganizationMissionTeamTemplateCatalog>(catalogPath);
      const templateEntries = Object.entries(payload.templates || {});
      const templateIds = templateEntries.map(([templateId]) => templateId).sort();
      let optionalRoleCount = 0;
      let requiredRoleCount = 0;
      for (const [, template] of templateEntries) {
        optionalRoleCount += template.optional_roles?.length || 0;
        requiredRoleCount += template.required_roles?.length || 0;
      }
      return {
        organization_id: (payload.organization_id || file.replace(/\.json$/i, '')).trim(),
        catalog_id: file.replace(/\.json$/i, ''),
        template_ids: templateIds,
        template_count: templateEntries.length,
        optional_role_count: optionalRoleCount,
        required_role_count: requiredRoleCount,
      };
    });
}

export function listOrganizationMissionTeamTemplateCatalogSummariesForOrganization(
  organizationProfile?: OrganizationProfile | null
): OrganizationMissionTeamTemplateCatalogSelectionSummary[] {
  const selectedCatalogId = resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile);
  return listOrganizationMissionTeamTemplateCatalogSummaries().map((catalog) => ({
    ...catalog,
    selected: Boolean(selectedCatalogId && catalog.catalog_id === selectedCatalogId),
  }));
}
