import * as path from 'node:path';
import type { OrganizationProfile } from './organization-profile.js';
import { resolveVision, type ResolvedVision } from './vision-resolver.js';
import { resolveOrganizationOrgChart, type OrganizationOrgChart } from './org-chart.js';
import { resolveDecisionRightsMatrix, type DecisionRightsMatrix } from './decision-rights.js';
import { resolveFinancialModel, type FinancialModel } from './financial-model.js';
import { resolveOkrTracker, type OkrTracker } from './okr-tracker.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import * as customerResolver from './customer-resolver.js';

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
  customer_ref: CompanyComponentRef<Record<string, unknown>>;
  identity_ref: CompanyComponentRef<Record<string, unknown>>;
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

function candidatePath(rootDir: string, tenantSlug: string, relativePath: string): string {
  return path.join(rootDir, 'customer', tenantSlug, relativePath);
}

function loadJsonComponent<T>(filePath: string): CompanyComponentRef<T> {
  const exists = safeExistsSync(filePath);
  if (!exists) {
    return { path: filePath, exists: false, data: null };
  }

  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return { path: filePath, exists: true, data: JSON.parse(raw) as T };
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

function loadCompanyOrganizationProfile(
  baseDir: string,
  tenantSlug: string
): CompanyComponentRef<OrganizationProfile> {
  const customerProfilePath = path.join(
    baseDir,
    'customer',
    tenantSlug,
    'organization-profile.json'
  );
  const publicProfilePath = path.join(
    baseDir,
    'knowledge',
    'product',
    'governance',
    'organization-profile.json'
  );
  const fallbackProfilePath = pathResolver.knowledge(
    'product/governance/organization-profile.json'
  );
  const candidates = [customerProfilePath, publicProfilePath, fallbackProfilePath];

  for (const candidate of candidates) {
    if (!safeExistsSync(candidate)) continue;
    try {
      const raw = safeReadFile(candidate, { encoding: 'utf8' }) as string;
      const data = JSON.parse(raw) as OrganizationProfile;
      return { path: candidate, exists: true, data };
    } catch {
      return { path: candidate, exists: true, data: null };
    }
  }

  return { path: customerProfilePath, exists: false, data: null };
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

function resolveCompanyIdentityName(
  customer: CompanyComponentRef<Record<string, unknown>>,
  identity: CompanyComponentRef<Record<string, unknown>>,
  organizationProfile: CompanyComponentRef<OrganizationProfile>,
  tenantSlug: string
): string {
  const customerRecord = customer.data as Record<string, unknown> | null;
  const identityRecord = identity.data as Record<string, unknown> | null;
  const customerName =
    readStringField(customerRecord, 'display_name') || readStringField(customerRecord, 'name');
  const profileName = readStringField(
    organizationProfile.data as unknown as Record<string, unknown> | null,
    'name'
  );
  const identityName =
    readStringField(identityRecord, 'name') || readStringField(identityRecord, 'display_name');

  return customerName || profileName || identityName || tenantSlug;
}

function resolveSovereignName(
  identity: CompanyComponentRef<Record<string, unknown>>,
  customer: CompanyComponentRef<Record<string, unknown>>,
  organizationProfile: CompanyComponentRef<OrganizationProfile>
): string | null {
  const identityName = readStringField(identity.data as Record<string, unknown> | null, 'name');
  if (identityName) return identityName;

  const customerRecord = customer.data as Record<string, unknown> | null;
  const primaryContact = customerRecord?.primary_contact as Record<string, unknown> | null;
  const contactName = readStringField(primaryContact, 'name');
  if (contactName) return contactName;

  const profileName = readStringField(
    organizationProfile.data as unknown as Record<string, unknown> | null,
    'name'
  );
  return profileName;
}

export function resolveCompany(tenantSlug?: string | null, rootDir?: string): CompanyAggregate {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = tenantSlug?.trim() || customerResolver.activeCustomer() || 'default';
  const customerPath = candidatePath(baseDir, resolvedTenantSlug, 'customer.json');
  const identityPath = candidatePath(baseDir, resolvedTenantSlug, 'identity.json');
  const customer = loadJsonComponent<Record<string, unknown>>(customerPath);
  const identity = loadJsonComponent<Record<string, unknown>>(identityPath);
  const organizationProfile = loadCompanyOrganizationProfile(baseDir, resolvedTenantSlug);
  const vision = resolveVision(resolvedTenantSlug, baseDir);
  const orgChart = resolveOrganizationOrgChart(resolvedTenantSlug, baseDir);
  const financial = resolveFinancialModel(resolvedTenantSlug, baseDir);
  const okr = resolveOkrTracker(resolvedTenantSlug, baseDir);

  return {
    company_id: resolvedTenantSlug,
    tenant_slug: resolvedTenantSlug,
    name: resolveCompanyIdentityName(customer, identity, organizationProfile, resolvedTenantSlug),
    sovereign: resolveSovereignName(identity, customer, organizationProfile),
    customer_ref: customer,
    identity_ref: identity,
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
