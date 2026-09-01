import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from './secure-io.js';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { loadAuthorityRoleIndex as loadGovernedAuthorityRoleIndex } from './authority-role-registry.js';
import type { OrganizationProfile } from './organization-profile.js';
import type {
  AuthorityRoleRecord,
  AgentProfileRecord,
  TeamRoleRecord,
} from './team-role-assignment-selection.js';
import { assertScopeContext, type ScopeContext } from './scope-context.js';

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

const AGENT_PROFILE_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/agent-profile-index.schema.json'
);
const TEAM_ROLE_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/team-role-index.schema.json'
);
const TEAM_ROLE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/team-role.schema.json');
const MISSION_TEAM_TEMPLATES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-team-templates.schema.json'
);
const ORGANIZATION_TEAM_TEMPLATE_CATALOG_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-team-template-catalog.schema.json'
);

function loadGovernedCatalog<T>(id: string, filePath: string, schemaPath: string): T {
  return defineCatalog<T>({ id, path: filePath, schema: schemaPath }).load();
}

function knowledgePath(rootDir: string | undefined, relativePath: string): string {
  const candidate = rootDir
    ? path.join(rootDir, 'knowledge', ...relativePath.split('/'))
    : pathResolver.knowledge(relativePath);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
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
  const dir = knowledgePath(rootDir, 'product/orchestration/agent-profiles');
  if (!safeExistsSync(dir)) return null;

  const profiles: Record<string, AgentProfileRecord> = {};
  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  for (const file of files) {
    const fullPath = assertSafeRepositoryPath(path.join(dir, file));
    const payload = loadGovernedCatalog<{
      version: string;
      agents: Record<string, AgentProfileRecord>;
    }>('agent-profile-index', fullPath, AGENT_PROFILE_INDEX_SCHEMA_PATH);
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
  const indexPath = knowledgePath(rootDir, 'product/orchestration/agent-profile-index.json');
  const index = loadGovernedCatalog<{
    version: string;
    agents: Record<string, AgentProfileRecord>;
  }>('agent-profile-index', indexPath, AGENT_PROFILE_INDEX_SCHEMA_PATH);
  return index.agents;
}

export function loadAuthorityRoleIndex(rootDir?: string): Record<string, AuthorityRoleRecord> {
  const roles = loadGovernedAuthorityRoleIndex(rootDir);
  return Object.fromEntries(
    Object.entries(roles).map(([role, record]) => {
      const { role: _role, ...withoutRole } = record;
      return [role, withoutRole];
    })
  ) as Record<string, AuthorityRoleRecord>;
}

export function loadTeamRoleDirectory(rootDir?: string): Record<string, TeamRoleRecord> | null {
  const dir = knowledgePath(rootDir, 'product/orchestration/team-roles');
  if (!safeExistsSync(dir)) return null;

  const roles: Record<string, TeamRoleRecord> = {};
  const files = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  for (const file of files) {
    const fullPath = assertSafeRepositoryPath(path.join(dir, file));
    const payload = loadGovernedCatalog<Record<string, unknown>>(
      'team-role',
      fullPath,
      TEAM_ROLE_SCHEMA_PATH
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

export function loadTeamRoleSnapshot(rootDir?: string): Record<string, TeamRoleRecord> {
  const index = loadGovernedCatalog<{
    version: string;
    team_roles: Record<string, TeamRoleRecord>;
  }>(
    'team-role-index',
    knowledgePath(rootDir, 'product/orchestration/team-role-index.json'),
    TEAM_ROLE_INDEX_SCHEMA_PATH
  );
  return index.team_roles;
}

export function loadTeamRoleIndex(rootDir?: string): Record<string, TeamRoleRecord> {
  return loadTeamRoleDirectory(rootDir) || loadTeamRoleSnapshot(rootDir);
}

export function loadAgentProfileIndex(rootDir?: string): Record<string, AgentProfileRecord> {
  const directoryProfiles = loadAgentProfileDirectory(rootDir);
  if (directoryProfiles) return directoryProfiles;
  return loadAgentProfileSnapshot(rootDir);
}

export function loadMissionTeamTemplates(
  organizationProfile?: OrganizationProfile | null,
  scope?: ScopeContext
): Record<string, MissionTeamTemplate> {
  const index = loadGovernedCatalog<{
    version: string;
    templates: Record<string, MissionTeamTemplate>;
  }>(
    'mission-team-templates',
    knowledgePath(undefined, 'product/orchestration/mission-team-templates.json'),
    MISSION_TEAM_TEMPLATES_SCHEMA_PATH
  );
  const templates = { ...index.templates };
  const catalogId = resolveOrganizationMissionTeamTemplateCatalogId(organizationProfile);
  if (catalogId) {
    const catalogPath = assertSafeRepositoryPath(
      pathResolver.knowledge(
        `product/governance/organization-team-template-catalogs/${catalogId}.json`
      ),
      { allowMissingLeaf: true }
    );
    if (safeExistsSync(catalogPath)) {
      const catalog = loadGovernedCatalog<OrganizationMissionTeamTemplateCatalog>(
        'organization-team-template-catalog',
        catalogPath,
        ORGANIZATION_TEAM_TEMPLATE_CATALOG_SCHEMA_PATH
      );
      for (const [templateId, overlay] of Object.entries(catalog.templates || {})) {
        const base = templates[templateId] || templates.default;
        if (!base) continue;
        templates[templateId] = mergeMissionTeamTemplate(base, overlay);
      }
    }
  }

  // Tenant/entity overlays are additive and resolve from tenant to organization
  // to project; the later, more specific layer wins. They are read only from
  // the authoritative tenant lane.
  const normalizedScope = scope ? assertScopeContext(scope, { requireTenant: true }) : undefined;
  const tenant = normalizedScope?.tenant_slug;
  if (tenant && normalizedScope) {
    const overlayPaths = [
      assertSafeRepositoryPath(
        pathResolver.knowledge(`confidential/${tenant}/orchestration/mission-team-templates.json`),
        { allowMissingLeaf: true }
      ),
      ...(normalizedScope.organization_id
        ? [
            assertSafeRepositoryPath(
              pathResolver.knowledge(
                `confidential/${tenant}/organizations/${normalizedScope.organization_id}/orchestration/mission-team-templates.json`
              ),
              { allowMissingLeaf: true }
            ),
          ]
        : []),
      ...(normalizedScope.project_id
        ? [
            assertSafeRepositoryPath(
              pathResolver.knowledge(
                `confidential/${tenant}/organizations/${normalizedScope.organization_id || '_'}/projects/${normalizedScope.project_id}/orchestration/mission-team-templates.json`
              ),
              { allowMissingLeaf: true }
            ),
          ]
        : []),
    ];
    for (const overlayPath of overlayPaths) {
      if (!safeExistsSync(overlayPath)) continue;
      const overlayCatalog = loadGovernedCatalog<{
        version: string;
        templates: Record<string, Partial<MissionTeamTemplate>>;
      }>('mission-team-templates-overlay', overlayPath, MISSION_TEAM_TEMPLATES_SCHEMA_PATH);
      for (const [templateId, overlay] of Object.entries(overlayCatalog.templates || {})) {
        const base = templates[templateId] || templates.default;
        if (base) templates[templateId] = mergeMissionTeamTemplate(base, overlay);
      }
    }
  }
  return templates;
}

export function listOrganizationMissionTeamTemplateCatalogSummaries(): OrganizationMissionTeamTemplateCatalogSummary[] {
  const catalogDir = knowledgePath(
    undefined,
    'product/governance/organization-team-template-catalogs'
  );
  if (!safeExistsSync(catalogDir)) return [];

  return safeReaddir(catalogDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((file) => {
      const catalogPath = assertSafeRepositoryPath(path.join(catalogDir, file));
      const payload = loadGovernedCatalog<OrganizationMissionTeamTemplateCatalog>(
        'organization-team-template-catalog',
        catalogPath,
        ORGANIZATION_TEAM_TEMPLATE_CATALOG_SCHEMA_PATH
      );
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
