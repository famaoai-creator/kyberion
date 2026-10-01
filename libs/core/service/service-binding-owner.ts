/**
 * Who owns a connection (service binding)?
 *
 *   person        — one member's own Gmail / calendar / personal bot. Credentials are theirs;
 *                   only they can revoke it. `owner_ref` = `user:<member_id>`.
 *   organization  — a tenant's Slack workspace / GitHub org / shared Drive. Credentials are the
 *                   organization's; owners and admins manage it. `owner_ref` = the tenant slug.
 *   operator      — the environment's runtime (reasoning backend, ComfyUI, Whisper). Not shown on
 *                   day-to-day surfaces. `owner_ref` is omitted.
 *
 * Records written before this field existed have no `owner_kind`; it is derived from
 * `tenant_slug` (organization when present, otherwise person) and made explicit the next time
 * the record is saved. A derived owner is never silently "operator": that is always a decision.
 */

export const BINDING_OWNER_KINDS = ['person', 'organization', 'operator'] as const;
export type BindingOwnerKind = (typeof BINDING_OWNER_KINDS)[number];

export interface BindingOwnerFields {
  owner_kind?: BindingOwnerKind;
  owner_ref?: string;
  tenant_slug?: string;
}

export interface BindingOwner {
  owner_kind: BindingOwnerKind;
  owner_ref?: string;
  /** True when the record did not declare an owner and this was inferred. */
  derived: boolean;
}

const MEMBER_REF = /^user:[a-z][a-z0-9-]*$/;

/** The declared owner, or the one implied by `tenant_slug`. */
export function resolveBindingOwner(record: BindingOwnerFields): BindingOwner {
  if (record.owner_kind) {
    return {
      owner_kind: record.owner_kind,
      ...(record.owner_ref ? { owner_ref: record.owner_ref } : {}),
      derived: false,
    };
  }
  if (record.tenant_slug) {
    return { owner_kind: 'organization', owner_ref: record.tenant_slug, derived: true };
  }
  return { owner_kind: 'person', derived: true };
}

/** Human-readable problems with the declared owner; empty when coherent. */
export function validateBindingOwner(record: BindingOwnerFields): string[] {
  const owner = resolveBindingOwner(record);
  const problems: string[] = [];
  if (!(BINDING_OWNER_KINDS as readonly string[]).includes(owner.owner_kind)) {
    return [
      `owner_kind '${String(owner.owner_kind)}' is not one of ${BINDING_OWNER_KINDS.join('/')}`,
    ];
  }
  if (owner.owner_kind === 'organization') {
    if (!record.tenant_slug) problems.push('an organization connection needs tenant_slug');
    if (owner.owner_ref && record.tenant_slug && owner.owner_ref !== record.tenant_slug) {
      problems.push(
        `owner_ref '${owner.owner_ref}' must equal tenant_slug '${record.tenant_slug}'`
      );
    }
  }
  if (owner.owner_kind === 'person') {
    if (record.tenant_slug) {
      problems.push(
        'a person connection must not carry tenant_slug (it would leak across tenants)'
      );
    }
    if (record.owner_kind && !(owner.owner_ref && MEMBER_REF.test(owner.owner_ref))) {
      problems.push('a person connection needs owner_ref like user:<member_id>');
    }
  }
  if (owner.owner_kind === 'operator') {
    if (record.tenant_slug) problems.push('an operator connection must not carry tenant_slug');
    if (owner.owner_ref) problems.push('an operator connection has no owner_ref');
  }
  return problems;
}

/**
 * May this viewer see the connection at all? Person connections are visible to their owner only;
 * organization connections to members of that tenant; operator connections never on day-to-day
 * surfaces. `viewer.tenantSlugs` is the server-resolved allowed set (never a client parameter).
 */
export function isBindingVisibleTo(
  record: BindingOwnerFields,
  viewer: { memberId?: string; tenantSlugs: readonly string[] | 'all' }
): boolean {
  const owner = resolveBindingOwner(record);
  if (owner.owner_kind === 'operator') return false;
  if (owner.owner_kind === 'person') {
    if (!viewer.memberId) return false;
    // A derived person owner has no ref (legacy record): visible to any identified member of the
    // single-operator deployments that predate ownership, never to an unidentified viewer.
    return owner.owner_ref ? owner.owner_ref === `user:${viewer.memberId}` : true;
  }
  return viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(owner.owner_ref ?? '');
}
