import * as path from 'node:path';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';

const ORGANIZATION_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-profile.schema.json'
);
const ORGANIZATION_PROFILE_PATH = pathResolver.knowledge(
  'product/governance/organization-profile.json'
);

export interface OrganizationProfileLlmOverride {
  description?: string;
  command?: string;
  args?: string[];
  timeout_ms?: number;
  response_format?: string;
  adapter?: string;
}

export interface OrganizationProfileWorkforce {
  mode?: string;
  accountable_owner_id?: string;
  accountable_human_resource_id?: string;
  default_approval_holder?: string;
  default_budget_posture?: string;
  resource_catalog_id?: string;
  default_resource_status?: 'active' | 'suspended' | 'revoked';
}

export interface OrganizationProfile {
  version: string;
  organization_id: string;
  name: string;
  description?: string;
  operating_principles?: string[];
  accountable_human_resource_id?: string;
  mission_defaults?: {
    default_mission_class?: string;
    default_team_template?: string;
    default_agent_profile?: string;
  };
  team_defaults?: {
    default_team_template?: string;
    team_template_catalog_id?: string;
    default_lifecycle_template?: string;
    max_parallel_missions?: number;
  };
  workforce?: OrganizationProfileWorkforce;
  llm?: {
    purpose_map?: Record<string, string>;
    default_profile?: string;
    profile_overrides?: Record<string, OrganizationProfileLlmOverride>;
  };
}

function loadOrganizationProfileCatalog(filePath: string): OrganizationProfile {
  return defineCatalog<OrganizationProfile>({
    id: 'organization-profile',
    path: filePath,
    schema: ORGANIZATION_PROFILE_SCHEMA_PATH,
  }).load();
}

/** Load a known organization-profile path through the canonical schema boundary. */
export function loadOrganizationProfileAtPath(filePath: string): OrganizationProfile {
  return loadOrganizationProfileCatalog(assertSafeRepositoryPath(filePath));
}

export function loadOrganizationProfile(rootDir?: string): OrganizationProfile | null {
  const customerSlug = customerResolver.activeCustomer();
  const rootScopedCustomerPath =
    rootDir && customerSlug
      ? assertSafeRepositoryPath(
          path.join(rootDir, 'customer', customerSlug, 'organization-profile.json'),
          { allowMissingLeaf: true, rootDir }
        )
      : null;
  const activeCustomerPath = rootDir
    ? null
    : customerSlug
      ? customerResolver.customerRoot('organization-profile.json')
      : null;
  const candidatePaths = [
    rootScopedCustomerPath,
    activeCustomerPath,
    rootDir
      ? assertSafeRepositoryPath(
          path.join(rootDir, 'knowledge', 'public', 'governance', 'organization-profile.json'),
          { allowMissingLeaf: true, rootDir }
        )
      : null,
    rootDir ? null : ORGANIZATION_PROFILE_PATH,
  ].filter((entry): entry is string => Boolean(entry));

  for (const profilePath of candidatePaths) {
    let safeProfilePath: string;
    try {
      safeProfilePath = assertSafeRepositoryPath(profilePath, { allowMissingLeaf: true, rootDir });
    } catch {
      continue;
    }
    if (!safeExistsSync(safeProfilePath)) continue;
    try {
      return loadOrganizationProfileCatalog(safeProfilePath);
    } catch {
      // try next candidate
    }
  }
  return null;
}
