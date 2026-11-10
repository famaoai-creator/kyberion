import * as path from 'node:path';
import type { OrganizationProfile } from './organization-profile.js';
import { resolveVision, type ResolvedVision } from './vision-resolver.js';
import { resolveOrganizationOrgChart, type OrganizationOrgChart } from './org-chart.js';
import { resolveDecisionRightsMatrix, type DecisionRightsMatrix } from './decision-rights.js';
import { resolveFinancialModel, type FinancialModel } from '../finance/financial-model.js';
import { resolveOkrTracker, type OkrTracker } from './okr-tracker.js';
import { pathResolver } from '../path-resolver.js';
import { parseSafeJsonObjectValue, readJson } from '../foundation/json.js';
import { safeExistsSync, safeLstat } from '../secure-io.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { activeTenantSlug, tenantHomePath, TENANT_COMPANY_FILE } from './tenant-home.js';
import {
  legacyOrganizationProfilePath,
  loadOrganizationProfileAtPath,
  ORGANIZATION_PROFILE_FILE,
  organizationProfilePath,
  resolveTenantOrganizationProfilePath,
} from './organization-profile.js';

export interface CompanyComponentRef<T = unknown> {
  path: string;
  exists: boolean;
  data: T | null;
}

export interface CompanyAggregate {
  company_id: string;
  tenant_slug: string;
  name: string;
  sovereign: string | null;
  /** The company descriptor, `knowledge/confidential/{tenant}/company.json`. */
  company_ref: CompanyComponentRef<Record<string, unknown>>;
  organization_profile_ref: CompanyComponentRef<OrganizationProfile>;
  vision_ref: ResolvedVision;
  org_chart_ref: CompanyComponentRef<OrganizationOrgChart>;
  financial_ref: CompanyComponentRef<FinancialModel>;
  okr_ref: CompanyComponentRef<OkrTracker>;
  decision_rights_ref: CompanyComponentRef<DecisionRightsMatrix>;
}

export function buildCompanyVisionRef(tenantSlug?: string | null): string {
  const slug = tenantSlug?.trim() || 'default';
  return `company://${slug}/vision`;
}

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function loadJsonComponent<T>(filePath: string): CompanyComponentRef<T> {
  const exists = safeExistsSync(filePath);
  if (!exists) {
    return { path: filePath, exists: false, data: null };
  }

  try {
    if (!safeLstat(filePath).isFile()) {
      return { path: filePath, exists: true, data: null };
    }
    const value = parseSafeJsonObjectValue(
      readJson<unknown>(filePath),
      `company component ${path.basename(filePath)}`
    );
    return { path: filePath, exists: true, data: value as T };
  } catch {
    return { path: filePath, exists: true, data: null };
  }
}

function readStringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The company's organization profile through the one organization-profile
 * resolution path (`resolveTenantOrganizationProfilePath`: the organization's
 * own profile, else the legacy tenant-root profile for one release), then the
 * product default. Company is an alias of tenant (concept model v2 D3), so
 * there is no company-specific profile store.
 */
function loadCompanyOrganizationProfile(
  baseDir: string,
  tenantSlug: string,
  organizationId?: string | null
): CompanyComponentRef<OrganizationProfile> {
  const tenantProfilePath =
    resolveTenantOrganizationProfilePath(tenantSlug, organizationId, baseDir)?.path ??
    (organizationId
      ? organizationProfilePath(tenantSlug, organizationId, baseDir)
      : legacyOrganizationProfilePath(tenantSlug, baseDir));
  const publicProfilePath = path.join(
    baseDir,
    'knowledge',
    'product',
    'governance',
    ORGANIZATION_PROFILE_FILE
  );
  const fallbackProfilePath = pathResolver.knowledge(
    `product/governance/${ORGANIZATION_PROFILE_FILE}`
  );
  const candidates = [tenantProfilePath, publicProfilePath, fallbackProfilePath];

  for (const candidate of candidates) {
    if (!safeExistsSync(candidate)) continue;
    try {
      const data = loadOrganizationProfileAtPath(candidate);
      return { path: candidate, exists: true, data };
    } catch {
      return { path: candidate, exists: true, data: null };
    }
  }

  return { path: tenantProfilePath, exists: false, data: null };
}

function loadCompanyDecisionRights(
  baseDir: string,
  tenantSlug: string
): CompanyComponentRef<DecisionRightsMatrix> {
  const matrix = resolveDecisionRightsMatrix(tenantSlug, baseDir);
  return {
    path: matrix.source_path,
    exists: matrix.decisions.length > 0 || safeExistsSync(matrix.source_path),
    data: matrix,
  };
}

function resolveCompanyName(
  company: CompanyComponentRef<Record<string, unknown>>,
  organizationProfile: CompanyComponentRef<OrganizationProfile>,
  tenantSlug: string
): string {
  const companyRecord = company.data as Record<string, unknown> | null;
  const companyName =
    readStringField(companyRecord, 'display_name') || readStringField(companyRecord, 'name');
  const profileName = readStringField(
    organizationProfile.data as unknown as Record<string, unknown> | null,
    'name'
  );
  return companyName || profileName || tenantSlug;
}

/** The company's accountable person: its primary contact, else the profile name. */
function resolveSovereignName(
  company: CompanyComponentRef<Record<string, unknown>>,
  organizationProfile: CompanyComponentRef<OrganizationProfile>
): string | null {
  const companyRecord = company.data as Record<string, unknown> | null;
  const primaryContact = companyRecord?.primary_contact as Record<string, unknown> | null;
  const contactName = readStringField(primaryContact, 'name');
  if (contactName) return contactName;
  return readStringField(
    organizationProfile.data as unknown as Record<string, unknown> | null,
    'name'
  );
}

/**
 * Company is an alias of tenant (concept model v2 D3), not a third level: the
 * company id IS the tenant slug, resolved the same way every tenant-scoped
 * reader resolves it — explicit, else the active tenant. `'default'` remains
 * only the no-tenant placeholder of the product checkout.
 */
export function resolveCompanyTenantSlug(tenantSlug?: string | null): string {
  const resolved = tenantSlug?.trim() || activeTenantSlug() || 'default';
  if (!isValidTenantSlug(resolved)) {
    throw new Error(`[COMPANY_TENANT_SCOPE] invalid tenant slug: ${resolved}`);
  }
  return resolved;
}

export function resolveCompany(
  tenantSlug?: string | null,
  rootDir?: string,
  organizationId?: string | null
): CompanyAggregate {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = resolveCompanyTenantSlug(tenantSlug);
  const company = loadJsonComponent<Record<string, unknown>>(
    tenantHomePath(resolvedTenantSlug, TENANT_COMPANY_FILE, baseDir)
  );
  const organizationProfile = loadCompanyOrganizationProfile(
    baseDir,
    resolvedTenantSlug,
    organizationId
  );
  const vision = resolveVision(resolvedTenantSlug, baseDir);
  const orgChart = resolveOrganizationOrgChart(resolvedTenantSlug, baseDir);
  const financial = resolveFinancialModel(resolvedTenantSlug, baseDir);
  const okr = resolveOkrTracker(resolvedTenantSlug, baseDir);

  return {
    company_id: resolvedTenantSlug,
    tenant_slug: resolvedTenantSlug,
    name: resolveCompanyName(company, organizationProfile, resolvedTenantSlug),
    sovereign: resolveSovereignName(company, organizationProfile),
    company_ref: company,
    organization_profile_ref: organizationProfile,
    vision_ref: vision,
    org_chart_ref: { path: orgChart.source_path, exists: true, data: orgChart },
    financial_ref: {
      path: financial.source_path,
      exists: financial.source_kind !== 'derived' || financial.periods.length > 0,
      data: financial,
    },
    okr_ref: {
      path: okr.source_path,
      exists: okr.source_kind !== 'derived' || okr.objectives.length > 0,
      data: okr,
    },
    decision_rights_ref: loadCompanyDecisionRights(baseDir, resolvedTenantSlug),
  };
}
