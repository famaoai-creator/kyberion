import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

const ORGANIZATION_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/organization-profile.schema.json'
);
const ORGANIZATION_PROFILE_PATH = pathResolver.knowledge(
  'product/governance/organization-profile.json'
);

let organizationProfileValidateFn: ValidateFunction | null = null;

export interface OrganizationProfileLlmOverride {
  description?: string;
  command?: string;
  args?: string[];
  timeout_ms?: number;
  response_format?: string;
  adapter?: string;
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
  llm?: {
    purpose_map?: Record<string, string>;
    default_profile?: string;
    profile_overrides?: Record<string, OrganizationProfileLlmOverride>;
  };
}

function ensureOrganizationProfileValidator(): ValidateFunction {
  if (organizationProfileValidateFn) return organizationProfileValidateFn;
  organizationProfileValidateFn = compileSchema(ORGANIZATION_PROFILE_SCHEMA_PATH);
  return organizationProfileValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function loadOrganizationProfile(rootDir?: string): OrganizationProfile | null {
  const customerSlug = customerResolver.activeCustomer();
  const rootScopedCustomerPath =
    rootDir && customerSlug
      ? path.join(rootDir, 'customer', customerSlug, 'organization-profile.json')
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
      ? path.join(rootDir, 'knowledge', 'public', 'governance', 'organization-profile.json')
      : null,
    rootDir ? null : ORGANIZATION_PROFILE_PATH,
  ].filter((entry): entry is string => Boolean(entry));

  for (const profilePath of candidatePaths) {
    if (!safeExistsSync(profilePath)) continue;
    try {
      const parsed = JSON.parse(
        safeReadFile(profilePath, { encoding: 'utf8' }) as string
      ) as OrganizationProfile;
      const validate = ensureOrganizationProfileValidator();
      if (!validate(parsed)) {
        throw new Error(`Invalid organization-profile: ${errorsFrom(validate).join('; ')}`);
      }
      return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}
