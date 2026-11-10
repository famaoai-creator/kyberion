import type { DotActionRecord } from './dot-action-ledger.js';
import { getWorkItem } from '../workforce/work-coordination.js';
import type { CreateWorkItemInput } from '../workforce/work-coordination-types.js';
import { sharesWorkItemTenantScope } from '../workforce/work-item-hierarchy.js';

/**
 * D1: a dot action that targets an existing WorkItem (`target: work_item:<id>`)
 * acts on behalf of that Issue, so its WorkItem becomes a child of it — when
 * the target exists in the same tenant scope. Any other action (path, service,
 * pr, org_operation, a mission admission, or no target) has no natural parent
 * and stays a top-level WorkItem.
 */
export function dotParentItemId(
  record: Pick<DotActionRecord, 'target'>,
  context: CreateWorkItemInput['context'],
  rootDir?: string
): string | undefined {
  const target = record.target?.startsWith('work_item:')
    ? record.target.slice('work_item:'.length).trim()
    : '';
  if (!target) return undefined;
  const parent = getWorkItem(target, rootDir ? { rootDir } : {});
  return parent && sharesWorkItemTenantScope(parent.context, context) ? parent.item_id : undefined;
}
