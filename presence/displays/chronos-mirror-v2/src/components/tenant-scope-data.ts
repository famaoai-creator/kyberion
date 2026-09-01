import { optionalStringField, recordField, stringField } from '../lib/json-record';

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

export function normalizeChronosTenantScopePayload(
  payload: unknown
): ChronosTenantScopeData | null {
  const root = recordField(payload);
  if (!Array.isArray(root.tenants)) return null;

  const tenants = root.tenants.flatMap((value): ChronosTenantOption[] => {
    if (typeof value === 'string' && value.trim()) {
      const slug = value.trim();
      return [{ slug, displayName: slug }];
    }
    const record = recordField(value);
    const slug = stringField(record, 'slug').trim();
    if (!slug) return [];
    return [
      {
        slug,
        displayName: stringField(record, 'displayName', slug).trim() || slug,
        ...(optionalStringField(record, 'status')
          ? { status: optionalStringField(record, 'status') }
          : {}),
      },
    ];
  });

  const organizations = Array.isArray(root.organizations)
    ? root.organizations.flatMap((value): ChronosOrganizationOption[] => {
        const record = recordField(value);
        const id = stringField(record, 'id').trim();
        if (!id) return [];
        const tenantSlug = optionalStringField(record, 'tenant_slug');
        return [{ id, ...(tenantSlug ? { tenant_slug: tenantSlug } : {}) }];
      })
    : [];

  const projects = Array.isArray(root.projects)
    ? root.projects.flatMap((value): ChronosProjectOption[] => {
        const record = recordField(value);
        const id = stringField(record, 'id').trim();
        if (!id) return [];
        const name = stringField(record, 'name', id).trim() || id;
        const organizationId = optionalStringField(record, 'organization_id');
        const tenantSlug = optionalStringField(record, 'tenant_slug');
        const status = optionalStringField(record, 'status');
        return [
          {
            id,
            name,
            ...(organizationId ? { organization_id: organizationId } : {}),
            ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
            ...(status ? { status } : {}),
          },
        ];
      })
    : [];

  return { tenants, organizations, projects };
}
