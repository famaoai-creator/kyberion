import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import type { TeamRoleRecord } from './team-role-assignment-selection.js';

export interface OrganizationOrgChartDomain {
  domain_id: string;
  name: string;
  role_ids: string[];
}

export interface OrganizationOrgChartPosition {
  role_id: string;
  reports_to: string | null;
  held_by: string;
  responsibility_scope: string;
  authority_role_ref: string | null;
}

export interface OrganizationOrgChart {
  version: string;
  organization_id: string;
  name: string;
  source_kind: 'customer' | 'confidential' | 'public' | 'derived';
  source_path: string;
  domains: OrganizationOrgChartDomain[];
  positions: OrganizationOrgChartPosition[];
}

export interface OrganizationOrgChartSummary {
  organization_id: string;
  name: string;
  source_kind: OrganizationOrgChart['source_kind'];
  domain_count: number;
  position_count: number;
  top_level_roles: string[];
}

const DEFAULT_ORG_CHART_PATHS = [
  (baseDir: string, tenantSlug: string) =>
    path.join(baseDir, 'customer', tenantSlug, 'org-chart.json'),
  (baseDir: string, tenantSlug: string) =>
    path.join(
      baseDir,
      'knowledge',
      'confidential',
      tenantSlug,
      'organization',
      'org-chart-2604.json'
    ),
  (baseDir: string, tenantSlug: string) =>
    path.join(baseDir, 'knowledge', 'confidential', tenantSlug, 'org-chart.json'),
  (baseDir: string) => path.join(baseDir, 'knowledge', 'product', 'governance', 'org-chart.json'),
];

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function normalizeRoleId(label: string): string {
  const cleaned = label
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const aliases: Record<string, string> = {
    legal_and_ip_strategist: 'legal_strategist',
    marketing_and_growth: 'marketing_growth',
    talent_and_culture: 'talent_culture',
    finance_controller: 'finance_controller',
    cyber_security_lead: 'cyber_security',
    executive_assistant: 'executive_assistant',
    customer_success: 'customer_success',
    business_owner: 'business_owner',
    sovereign_concierge: 'sovereign_concierge',
    experience_designer: 'experience_designer',
    line_manager: 'line_manager',
  };
  return aliases[cleaned] || cleaned;
}

function loadJsonIfPresent<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function isOrgChartCandidate(value: unknown): value is OrganizationOrgChart {
  if (!value || typeof value !== 'object') return false;
  const chart = value as Record<string, unknown>;
  return Array.isArray(chart.positions) && Array.isArray(chart.domains);
}

function loadTeamRoleIndexFromRoot(baseDir: string): Record<string, TeamRoleRecord> {
  const filePath = path.join(
    baseDir,
    'knowledge',
    'product',
    'orchestration',
    'team-role-index.json'
  );
  const payload = loadJsonIfPresent<{ team_roles?: Record<string, TeamRoleRecord> }>(filePath);
  return payload?.team_roles || {};
}

function loadAuthorityRoleIndexFromRoot(
  baseDir: string
): Record<string, { scope_classes?: string[] }> {
  const indexPath = path.join(
    baseDir,
    'knowledge',
    'product',
    'governance',
    'authority-role-index.json'
  );
  const payload = loadJsonIfPresent<{
    authority_roles?: Record<string, { scope_classes?: string[] }>;
  }>(indexPath);
  return payload?.authority_roles || {};
}

function loadDomainCatalog(baseDir: string): OrganizationOrgChartDomain[] {
  const catalog = loadJsonIfPresent<{
    domains?: Record<string, { name?: string; roles?: Record<string, string> }>;
  }>(path.join(baseDir, 'knowledge', 'product', 'personalities', 'roles.json'));

  const domains = Object.values(catalog?.domains || {});
  const knownRoles = new Set<string>();
  const result = domains.map((domain, index) => {
    const roleIds = Object.values(domain.roles || {})
      .map((role) => normalizeRoleId(role))
      .filter(Boolean);
    roleIds.forEach((roleId) => knownRoles.add(roleId));
    return {
      domain_id: `domain_${index + 1}`,
      name: domain.name || `Domain ${index + 1}`,
      role_ids: roleIds,
    };
  });
  const teamRoles = loadTeamRoleIndexFromRoot(baseDir);
  const residualRoleIds = Object.keys(teamRoles)
    .map((roleId) => roleId.trim())
    .filter((roleId) => roleId && !knownRoles.has(roleId));

  if (residualRoleIds.length > 0) {
    result.push({
      domain_id: 'mission_orchestration',
      name: 'Mission Orchestration',
      role_ids: residualRoleIds.sort(),
    });
  }

  return result;
}

function inferHeldBy(teamRole: TeamRoleRecord): string {
  const preferredAgent = teamRole.selection_hints?.preferred_agents?.[0]?.trim();
  return preferredAgent || 'human';
}

function buildDerivedOrgChart(
  baseDir: string,
  organizationId: string,
  name: string,
  sourcePath: string
): OrganizationOrgChart {
  const teamRoles = loadTeamRoleIndexFromRoot(baseDir);
  const authorityRoles = loadAuthorityRoleIndexFromRoot(baseDir);
  const positions: OrganizationOrgChartPosition[] = Object.entries(teamRoles)
    .map(([roleId, role]) => ({
      role_id: roleId,
      reports_to: role.escalation_parent_team_role || null,
      held_by: inferHeldBy(role),
      responsibility_scope: role.ownership_scope,
      authority_role_ref:
        role.compatible_authority_roles.find((authorityRole) =>
          Boolean(authorityRoles[authorityRole])
        ) || null,
    }))
    .sort((left, right) => left.role_id.localeCompare(right.role_id));

  return {
    version: '1.0.0',
    organization_id: organizationId,
    name,
    source_kind: 'derived',
    source_path: sourcePath,
    domains: loadDomainCatalog(baseDir),
    positions,
  };
}

function loadOrgChartFromCandidates(
  baseDir: string,
  tenantSlug: string
): OrganizationOrgChart | null {
  for (const candidateBuilder of DEFAULT_ORG_CHART_PATHS) {
    const candidatePath = candidateBuilder(baseDir, tenantSlug);
    const parsed = loadJsonIfPresent<OrganizationOrgChart>(candidatePath);
    if (parsed && isOrgChartCandidate(parsed)) {
      return {
        ...parsed,
        source_path: candidatePath,
        source_kind: candidatePath.includes('/customer/')
          ? 'customer'
          : candidatePath.includes('/confidential/')
            ? 'confidential'
            : 'public',
      };
    }
  }
  return null;
}

export function resolveOrganizationOrgChart(
  tenantSlug?: string | null,
  rootDir?: string
): OrganizationOrgChart {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = tenantSlug?.trim() || null;
  const organizationId = resolvedTenantSlug || 'default';
  const name = resolvedTenantSlug
    ? `${resolvedTenantSlug} Org Chart`
    : 'Default Organization Org Chart';
  const loaded = resolvedTenantSlug
    ? loadOrgChartFromCandidates(baseDir, resolvedTenantSlug)
    : null;
  if (loaded) return loaded;
  return buildDerivedOrgChart(
    baseDir,
    organizationId,
    name,
    path.join(baseDir, 'knowledge', 'product', 'governance', 'org-chart.derived.json')
  );
}

export function summarizeOrganizationOrgChart(
  chart?: OrganizationOrgChart | null
): OrganizationOrgChartSummary | undefined {
  if (!chart) return undefined;
  return {
    organization_id: chart.organization_id,
    name: chart.name,
    source_kind: chart.source_kind,
    domain_count: chart.domains.length,
    position_count: chart.positions.length,
    top_level_roles: chart.positions
      .filter((position) => position.reports_to == null)
      .map((position) => position.role_id)
      .sort(),
  };
}
