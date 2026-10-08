import { logger } from '../core.js';
import {
  listAgentIdentities,
  getAgentIdentity,
  type AgentIdentityRecord,
} from '../agent/agent-identity.js';
import { listMemberIds, readMemberProfile, type MemberProfile } from './member-registry.js';
import { listOrphanNhiIdentities } from '../nhi-lifecycle-governance.js';

export type IdentityKind = 'human' | 'agent' | 'service';

export interface IdentityDirectoryHuman {
  kind: 'human';
  actor: string;
  member: MemberProfile;
}

export interface IdentityDirectoryAgent {
  kind: IdentityKind;
  actor: string;
  record: AgentIdentityRecord;
  orphan: boolean;
}

export type IdentityDirectoryEntry = IdentityDirectoryHuman | IdentityDirectoryAgent;

export interface IdentityDirectoryFilter {
  organization_id?: string;
  tenant_slug?: string;
  kind?: IdentityKind;
  includeRetired?: boolean;
}

function memberMatches(member: MemberProfile, filter: IdentityDirectoryFilter): boolean {
  // membershipはtenant単位で組織を持たないため organization_id単独では絞れない。
  // org指定時はhumanを返さない(fail-open防止)。tenant指定時はmembershipで絞る。
  if (filter.organization_id && !filter.tenant_slug) return false;
  if (filter.tenant_slug) {
    if (!member.memberships.some((m) => m.tenant_slug === filter.tenant_slug)) return false;
  }
  return true;
}

export function listIdentityDirectory(
  filter: IdentityDirectoryFilter = {}
): IdentityDirectoryEntry[] {
  const out: IdentityDirectoryEntry[] = [];
  if (!filter.kind || filter.kind === 'human') {
    for (const id of listMemberIds()) {
      const member = readMemberProfile(id);
      if (!member || member.status !== 'active') continue;
      if (!memberMatches(member, filter)) continue;
      out.push({ kind: 'human', actor: `user:${member.member_id}`, member });
    }
  }
  if (!filter.kind || filter.kind === 'agent' || filter.kind === 'service') {
    const orphans = new Set(listOrphanNhiIdentities().map((o) => o.nhi_id));
    for (const record of listAgentIdentities({
      organization_id: filter.organization_id,
    })) {
      const kind = record.kind as IdentityKind;
      if (filter.kind && kind !== filter.kind) continue;
      if (filter.tenant_slug && record.affiliation.tenant_slug !== filter.tenant_slug) continue;
      if (!filter.includeRetired && record.lifecycle_status === 'retired') continue;
      out.push({ kind, actor: record.nhi_id, record, orphan: orphans.has(record.nhi_id) });
    }
  }
  logger.debug(`[identity-directory] listed ${out.length} entries`);
  return out;
}

export function showIdentity(actor: string): IdentityDirectoryEntry | null {
  const id = actor.trim();
  if (id.startsWith('user:')) {
    const member = readMemberProfile(id.slice('user:'.length));
    if (!member || member.status !== 'active') return null;
    return { kind: 'human', actor: id, member };
  }
  if (id.startsWith('kyberion://agent/')) {
    const record = getAgentIdentity(id);
    if (!record) return null;
    const orphan = listOrphanNhiIdentities().some((o) => o.nhi_id === id);
    return { kind: record.kind as IdentityKind, actor: id, record, orphan };
  }
  return null;
}
