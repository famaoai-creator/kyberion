/**
 * Which connections a viewer may see, and how they are grouped on the
 * connections pane ("yours" vs "your organization's"). Pure: the route supplies
 * the raw binding records and the server-resolved viewer; nothing here reads
 * the client. Credentials and secret references never leave the server: only
 * the fields below are projected.
 */

import {
  isBindingVisibleTo,
  resolveBindingOwner,
  type BindingOwnerFields,
  type BindingOwnerKind,
} from '@agent/core/service/service-binding-owner';

export interface ConnectionViewItem {
  binding_id: string;
  service_id: string;
  owner_kind: BindingOwnerKind;
  /** `user:<member>` for a person, the tenant slug for an organization. */
  owner_ref?: string;
  group: 'mine' | 'organization';
}

export interface ConnectionViewer {
  /** The local operator on this machine (loopback): sees everything that is not environment-owned. */
  loopback: boolean;
  memberId?: string;
  tenantSlugs: readonly string[] | 'all';
}

type RawBinding = BindingOwnerFields & { binding_id?: unknown; service_id?: unknown };

/**
 * Operator-owned connections (reasoning backend, local media services) never
 * appear on day-to-day surfaces. A person's connections are visible to their
 * owner only; an organization's to members of that tenant. The local operator on
 * loopback owns the machine, so legacy connections that predate ownership stay
 * visible to them rather than vanishing.
 */
export function visibleConnections(
  records: readonly unknown[],
  viewer: ConnectionViewer
): ConnectionViewItem[] {
  const out: ConnectionViewItem[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as RawBinding;
    if (typeof record.binding_id !== 'string' || typeof record.service_id !== 'string') continue;
    const owner = resolveBindingOwner(record);
    if (owner.owner_kind === 'operator') continue;
    const visible = viewer.loopback
      ? owner.owner_kind === 'person' ||
        viewer.tenantSlugs === 'all' ||
        viewer.tenantSlugs.includes(owner.owner_ref ?? '')
      : isBindingVisibleTo(record, {
          ...(viewer.memberId ? { memberId: viewer.memberId } : {}),
          tenantSlugs: viewer.tenantSlugs,
        });
    if (!visible) continue;
    out.push({
      binding_id: record.binding_id,
      service_id: record.service_id,
      owner_kind: owner.owner_kind,
      ...(owner.owner_ref ? { owner_ref: owner.owner_ref } : {}),
      group: owner.owner_kind === 'organization' ? 'organization' : 'mine',
    });
  }
  return out.sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      (a.owner_ref ?? '').localeCompare(b.owner_ref ?? '') ||
      a.binding_id.localeCompare(b.binding_id)
  );
}

/** Connections grouped for display: the viewer's own, then one block per organization. */
export function groupConnections(items: readonly ConnectionViewItem[]): {
  mine: ConnectionViewItem[];
  organizations: Array<{ tenant_slug: string; items: ConnectionViewItem[] }>;
} {
  const mine = items.filter((item) => item.group === 'mine');
  const byTenant = new Map<string, ConnectionViewItem[]>();
  for (const item of items) {
    if (item.group !== 'organization') continue;
    const slug = item.owner_ref ?? '';
    byTenant.set(slug, [...(byTenant.get(slug) ?? []), item]);
  }
  return {
    mine,
    organizations: [...byTenant.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tenant_slug, list]) => ({ tenant_slug, items: list })),
  };
}
