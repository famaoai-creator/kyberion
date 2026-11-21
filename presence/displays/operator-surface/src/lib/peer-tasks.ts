import { listPeerTasks } from '@agent/core/mesh/peer-task-exchange';
import { listWorkItems } from '@agent/core/workforce/work-coordination';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-viewer-scope-contract';

export function canReadPeerTasks(viewer: SurfaceViewerScope, tenant: string | undefined) {
  return Boolean(
    tenant &&
    viewer.tierAccess.includes('confidential') &&
    (viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(tenant)) &&
    viewer.organizationIds === 'all' &&
    viewer.projectIds === 'all'
  );
}

export function isPeerTaskPeerId(value: string) {
  return /^[a-z][a-z0-9-]{1,63}$/.test(value);
}

export function readOperatorPeerTasks(
  viewer: SurfaceViewerScope,
  tenant: string | undefined,
  peerId: string
) {
  if (!tenant || !canReadPeerTasks(viewer, tenant) || !isPeerTaskPeerId(peerId)) return [];

  const tasks = listPeerTasks(tenant, peerId, { direction: 'inbound' })
    .filter((task) => task.tenant_id === tenant && task.local_peer_id === peerId)
    .slice(-100)
    .reverse();
  const items = tasks.some((task) => task.work_item_id)
    ? listWorkItems({ tenantSlugs: [tenant], source: 'peer', assigneePeerId: peerId })
    : [];
  const itemsById = new Map(items.map((item) => [item.item_id, item]));
  const now = Date.now();

  return tasks.map((task) => {
    const item = task.work_item_id ? itemsById.get(task.work_item_id) : undefined;
    const workItem =
      item?.context?.tenant_slug === tenant &&
      item.source === 'peer' &&
      item.source_ref === `peer-task:${task.task_id}`
        ? { id: item.item_id, status: item.status }
        : null;
    return {
      id: task.task_id,
      type: task.task_type,
      requester: task.remote_peer_id,
      requestedAt: task.requested_at,
      state:
        task.state === 'pending' && Date.parse(task.expires_at) <= now
          ? ('expired' as const)
          : task.state,
      workItem,
      artifacts: task.result?.artifacts ?? [],
    };
  });
}
