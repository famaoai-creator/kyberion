import { isJsonRecord, type JsonRecord } from '../lib/json-record';

export interface ChronosTenantOption {
  slug: string;
  displayName: string;
  status?: string;
}

export interface ChronosOrganizationOption {
  id: string;
  tenant_slug?: string;
}

export interface ChronosProjectOption {
  id: string;
  name: string;
  organization_id?: string;
  tenant_slug?: string;
  status?: string;
}

export interface ChronosTenantScopeData {
  tenants: ChronosTenantOption[];
  organizations: ChronosOrganizationOption[];
  projects: ChronosProjectOption[];
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isJsonRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function hasField(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(record: JsonRecord, key: string): string | undefined | null {
  if (!hasField(record, key)) return undefined;
  if (typeof record[key] !== 'string') return null;
  const value = record[key].trim();
  return value || undefined;
}

function parseTenant(value: unknown): ChronosTenantOption | undefined {
  if (typeof value === 'string' && value.trim()) {
    const slug = value.trim();
    return { slug, displayName: slug };
  }
  if (!isJsonRecord(value) || !nonEmptyString(value.slug)) return undefined;
  const displayName = optionalString(value, 'displayName');
  const status = optionalString(value, 'status');
  if (displayName === null || status === null) return undefined;
  return {
    slug: value.slug.trim(),
    displayName: displayName || value.slug.trim(),
    ...(status ? { status } : {}),
  };
}

function parseOrganizations(value: unknown): ChronosOrganizationOption[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const organizations = value.map((entry) => {
    if (!isJsonRecord(entry) || !nonEmptyString(entry.id)) return undefined;
    const tenantSlug = optionalString(entry, 'tenant_slug');
    if (tenantSlug === null) return undefined;
    return { id: entry.id.trim(), ...(tenantSlug ? { tenant_slug: tenantSlug } : {}) };
  });
  return organizations.every((entry): entry is ChronosOrganizationOption => entry !== undefined)
    ? organizations
    : null;
}

function parseProjects(value: unknown): ChronosProjectOption[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const projects = value.map((entry) => {
    if (!isJsonRecord(entry) || !nonEmptyString(entry.id)) return undefined;
    const name = optionalString(entry, 'name');
    const organizationId = optionalString(entry, 'organization_id');
    const tenantSlug = optionalString(entry, 'tenant_slug');
    const status = optionalString(entry, 'status');
    if (name === null || organizationId === null || tenantSlug === null || status === null) {
      return undefined;
    }
    return {
      id: entry.id.trim(),
      name: name || entry.id.trim(),
      ...(organizationId ? { organization_id: organizationId } : {}),
      ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
      ...(status ? { status } : {}),
    };
  });
  return projects.every((entry): entry is ChronosProjectOption => entry !== undefined)
    ? projects
    : null;
}

export function normalizeChronosTenantScopePayload(
  payload: unknown
): ChronosTenantScopeData | null {
  if (!isJsonRecord(payload) || payload.ok !== true || !hasSafeTree(payload)) return null;
  if (!Array.isArray(payload.tenants)) return null;
  const tenants = payload.tenants.map(parseTenant);
  if (!tenants.every((entry): entry is ChronosTenantOption => entry !== undefined)) return null;
  const organizations = parseOrganizations(payload.organizations);
  const projects = parseProjects(payload.projects);
  if (!organizations || !projects) return null;
  return { tenants, organizations, projects };
}
