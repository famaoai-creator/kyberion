/** Pure WorkItem filtering and sorting; storage scope stays in the coordination facade. */
import type {
  WorkBoard,
  WorkItem,
  WorkItemFilter,
  WorkItemPriority,
} from './work-coordination-types.js';

const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};
function normalizeArray(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map((entry) => String(entry));
  if (typeof value === 'string' && value) return [value];
  return [];
}

export function applyWorkItemFilters(items: WorkItem[], filter: WorkItemFilter): WorkItem[] {
  const sources = normalizeArray(filter.source);
  const statuses = normalizeArray(filter.status);
  const labelSet = new Set(normalizeArray(filter.labels));
  const query = filter.text ? filter.text.trim().toLowerCase() : '';

  return items.filter((item) => {
    const metadata = item.metadata || {};
    const context = item.context || {};
    const organizationId =
      context.organization_id ||
      (typeof metadata.organization_id === 'string' ? metadata.organization_id : undefined);
    const projectId = context.project_id || item.project_id;
    const tenantSlugs = filter.tenantSlugs || filter.tenant_slugs;
    if (tenantSlugs) {
      const tenantSlug = item.context?.tenant_slug;
      if (!tenantSlug || !tenantSlugs.includes(tenantSlug)) return false;
    }
    const organizationIds = filter.organizationIds || filter.organization_ids;
    if (organizationIds && (!organizationId || !organizationIds.includes(organizationId)))
      return false;
    const projectIds = filter.projectIds || filter.project_ids;
    if (projectIds && (!projectId || !projectIds.includes(projectId))) return false;
    if (
      (filter.projectId || (filter as any).project_id) &&
      projectId !== (filter.projectId || (filter as any).project_id)
    )
      return false;
    if (sources.length > 0 && !sources.includes(item.source)) return false;
    if (statuses.length > 0 && !statuses.includes(item.status)) return false;
    if (
      (filter.assigneePeerId || (filter as any).assignee_peer_id) &&
      item.assignee_peer_id !== (filter.assigneePeerId || (filter as any).assignee_peer_id)
    )
      return false;
    if (
      (filter.assigneeUserId || (filter as any).assignee_user_id) &&
      item.assignee_user_id !== (filter.assigneeUserId || (filter as any).assignee_user_id)
    )
      return false;
    if (labelSet.size > 0) {
      const itemLabels = new Set(item.labels || []);
      for (const label of labelSet) {
        if (!itemLabels.has(label)) return false;
      }
    }
    if (query) {
      const haystack = [item.title, item.description, item.source_ref, item.project_id]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function sortItems(
  items: WorkItem[],
  sortBy: WorkBoard['sort_by'] = 'updated_at'
): WorkItem[] {
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case 'priority':
        return (
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          b.updated_at.localeCompare(a.updated_at)
        );
      case 'created_at':
        return b.created_at.localeCompare(a.created_at);
      case 'status':
        return a.status.localeCompare(b.status) || b.updated_at.localeCompare(a.updated_at);
      case 'updated_at':
      default:
        return b.updated_at.localeCompare(a.updated_at);
    }
  });
}
