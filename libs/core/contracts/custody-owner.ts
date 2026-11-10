/**
 * Custody owner — who is accountable for a piece of material, independent of
 * how sensitive it is (INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05 §管理スコープ, P1).
 *
 * The data tier answers "how sensitive is this?"; the custody owner answers
 * "whose statement about a processor applies to it?". Until P1 the tier did
 * both jobs (`personal` meant both "sensitive" and "the individual's"), and a
 * payload without a tenant had no custody owner at all, so no attestation could
 * ever cover it (SM-01 / SM-06).
 *
 * - `tenant` — material that belongs to a tenant; the tenant profile's provider
 *   attestations apply.
 * - `person` — personal material with no tenant; the person's own attestation
 *   applies. `principal_id` is optional: a single-user installation treats the
 *   current operator as the person (design Q-02 default).
 * - `system` — installation-level material that belongs to no tenant (system
 *   role drafts, product knowledge); the installation's attestation applies.
 *
 * Leaf module on purpose: it imports nothing but the slug rules, so both the
 * reasoning-send gate and the delegation gate can depend on it without a cycle.
 */
import type { StorageDataTier } from '../storage-layout.js';
import { isReservedScopeName, isValidTenantSlug } from '../foundation/scope.js';

export type CustodyOwner =
  | { kind: 'system' }
  | { kind: 'tenant'; tenant_slug: string }
  | { kind: 'person'; principal_id?: string };

export type CustodyOwnerKind = CustodyOwner['kind'];

export const CUSTODY_OWNER_KINDS: readonly CustodyOwnerKind[] = ['system', 'tenant', 'person'];

/** Error code prefix of a custody declaration that contradicts the scope. */
export const CUSTODY_OWNER_CONFLICT = '[CUSTODY_OWNER_CONFLICT]';

export class CustodyOwnerConflictError extends Error {
  constructor(reason: string) {
    super(`${CUSTODY_OWNER_CONFLICT} ${reason}`);
    this.name = 'CustodyOwnerConflictError';
  }
}

export interface CustodyOwnerInput {
  /** Most sensitive tier represented in the material. */
  tier: StorageDataTier;
  /** Tenant the material belongs to, if any. */
  tenant_slug?: string;
  /** Explicit custody declaration; may only agree with `tenant_slug`. */
  custody?: CustodyOwner;
}

const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:@._-]{0,127}$/u;

function normalizePrincipal(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PRINCIPAL_PATTERN.test(value.trim())) {
    throw new CustodyOwnerConflictError(
      `person custody principal_id '${String(value)}' is invalid`
    );
  }
  return value.trim();
}

/**
 * The custody owner of a payload. Derived when not declared: a tenant slug
 * means tenant custody, a personal tier without a tenant means person custody,
 * anything else is system custody.
 *
 * An explicit `custody` can only restate what the scope already says — it can
 * name the person behind tenantless material, or say "system" for tenantless
 * confidential material — and never move material across a tenant boundary.
 * Contradictions throw {@link CustodyOwnerConflictError} (fail closed):
 * - tenant custody without, or with a different, `tenant_slug`;
 * - system or person custody for material that names a tenant;
 * - system custody for personal-tier material (an installation statement must
 *   not speak for a person's material);
 * - an unknown kind or an invalid slug / principal id.
 */
export function deriveCustodyOwner(input: CustodyOwnerInput): CustodyOwner {
  const tenantSlug = typeof input.tenant_slug === 'string' ? input.tenant_slug.trim() : '';
  if (tenantSlug && (!isValidTenantSlug(tenantSlug) || isReservedScopeName(tenantSlug))) {
    throw new CustodyOwnerConflictError(`tenant_slug '${tenantSlug}' is not a valid tenant slug`);
  }
  const declared = input.custody;
  if (declared === undefined || declared === null) {
    if (tenantSlug) return { kind: 'tenant', tenant_slug: tenantSlug };
    if (input.tier === 'personal') return { kind: 'person' };
    return { kind: 'system' };
  }
  if (typeof declared !== 'object' || !CUSTODY_OWNER_KINDS.includes(declared.kind)) {
    throw new CustodyOwnerConflictError(
      `custody kind '${String((declared as { kind?: unknown })?.kind)}' is not one of ${CUSTODY_OWNER_KINDS.join(', ')}`
    );
  }
  if (declared.kind === 'tenant') {
    const declaredSlug =
      typeof declared.tenant_slug === 'string' ? declared.tenant_slug.trim() : '';
    if (!declaredSlug || declaredSlug !== tenantSlug) {
      throw new CustodyOwnerConflictError(
        `tenant custody '${declaredSlug || '(none)'}' does not match the scope tenant_slug '${tenantSlug || '(none)'}'`
      );
    }
    return { kind: 'tenant', tenant_slug: tenantSlug };
  }
  if (tenantSlug) {
    throw new CustodyOwnerConflictError(
      `${declared.kind} custody cannot hold material of tenant '${tenantSlug}'`
    );
  }
  if (declared.kind === 'system') {
    if (input.tier === 'personal') {
      throw new CustodyOwnerConflictError(
        'system custody cannot hold personal-tier material; declare person custody instead'
      );
    }
    return { kind: 'system' };
  }
  const principal = normalizePrincipal(declared.principal_id);
  return principal ? { kind: 'person', principal_id: principal } : { kind: 'person' };
}

/** Short, log-safe label: `system`, `tenant:<slug>`, `person` or `person:<principal>`. */
export function custodyOwnerLabel(owner: CustodyOwner): string {
  if (owner.kind === 'tenant') return `tenant:${owner.tenant_slug}`;
  if (owner.kind === 'person')
    return owner.principal_id ? `person:${owner.principal_id}` : 'person';
  return 'system';
}
