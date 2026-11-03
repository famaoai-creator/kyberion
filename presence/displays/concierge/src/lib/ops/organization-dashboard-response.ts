import type { OrganizationDashboardData } from './organization-dashboard';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const scope = (value: unknown) =>
  value === 'all' ||
  (Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0));

/** Validate every consumed field before allowing the Home renderer to use a response. */
export function parseOrganizationDashboard(value: unknown): OrganizationDashboardData | null {
  if (
    !record(value) ||
    value.ok !== true ||
    !['scope', 'organization', 'mine'].includes(String(value.mode)) ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !record(value.selection) ||
    !['tenant', 'organization', 'project', 'operation'].includes(String(value.selection.kind)) ||
    !record(value.viewer) ||
    typeof value.viewer.id !== 'string' ||
    typeof value.viewer.role !== 'string' ||
    !['tenants', 'organizations', 'projects'].every((key) =>
      scope((value.viewer as Record<string, unknown>)[key])
    ) ||
    !Array.isArray(value.viewer.tiers) ||
    !value.viewer.tiers.every((tier) => ['public', 'confidential', 'personal'].includes(tier)) ||
    !record(value.available) ||
    typeof value.available.mine !== 'boolean' ||
    typeof value.available.organization !== 'boolean' ||
    !record(value.counts) ||
    !['total', 'active', 'blocked', 'review', 'ready'].every((key) =>
      count((value.counts as Record<string, unknown>)[key])
    ) ||
    !count(value.attentionTotal) ||
    !Array.isArray(value.attention) ||
    value.attention.length > 10 ||
    (value.attentionTotal as number) < value.attention.length ||
    !value.attention.every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        ['blocked', 'review', 'ready'].includes(String(item.status)) &&
        typeof item.updatedAt === 'string'
    )
  )
    return null;
  for (const key of ['tenant_slug', 'organization_id', 'project_id', 'operation_id']) {
    const field = value.selection[key];
    if (field !== undefined && (typeof field !== 'string' || !field.trim())) return null;
  }
  if (
    value.selection.tier !== undefined &&
    !['public', 'confidential', 'personal'].includes(String(value.selection.tier))
  )
    return null;
  return value as unknown as OrganizationDashboardData;
}
