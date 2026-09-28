import { isValidTenantSlug } from '../entity-scope.js';

export function normalizeMissionTenantSlug(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return isValidTenantSlug(trimmed) ? trimmed : undefined;
}

export interface MissionVisionRefSummary {
  raw: string;
  kind: 'company' | 'vision' | 'legacy';
  tenant_slug: string | null;
  path: string | null;
  query: string | null;
}

export function parseMissionVisionRef(
  inputVisionRef: string | undefined | null,
  tenantSlug?: string | undefined
): MissionVisionRefSummary | null {
  const raw = String(inputVisionRef || '').trim();
  if (!raw) return null;

  if (raw.startsWith('company://')) {
    const remainder = raw.slice('company://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    const [parsedTenantSlug, ...segments] = pathPart.split('/').filter(Boolean);
    return {
      raw,
      kind: 'company',
      tenant_slug: normalizeMissionTenantSlug(parsedTenantSlug || tenantSlug || undefined) || null,
      path: segments.length ? segments.join('/') : 'vision',
      query: queryPart || null,
    };
  }

  if (raw.startsWith('vision://')) {
    const remainder = raw.slice('vision://'.length);
    const [pathPart, queryPart] = remainder.split('?', 2);
    return {
      raw,
      kind: 'vision',
      tenant_slug: normalizeMissionTenantSlug(tenantSlug || undefined) || null,
      path: pathPart || null,
      query: queryPart || null,
    };
  }

  return {
    raw,
    kind: 'legacy',
    tenant_slug: normalizeMissionTenantSlug(tenantSlug || undefined) || null,
    path: null,
    query: null,
  };
}
