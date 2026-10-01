/**
 * Server-side logic behind the charter pane (settings › organization and
 * members). The route files stay thin; everything that decides "who may do
 * what" lives here so it is one reviewable place:
 *
 *  - the tenant list is the viewer's own scope (a client `tenant` may only narrow);
 *  - the acting human is the authn-resolved member — a client never names who
 *    is accountable;
 *  - creating a charter needs an OWNER membership on that tenant; stopping or
 *    retiring needs the accountable human or a named deputy;
 *  - the statement the human saw is bound by digest at acceptance.
 */

import { humanActor } from '@agent/core/actor';
import {
  clearTripwire,
  findActiveCharter,
  recordTripwire,
  retireCharter,
  type CharterPathOptions,
} from '@agent/core/governance/accountability-charter-registry';
import {
  clearCharterProposal,
  readPendingProposal,
  submitCharterProposal,
  type CharterProposal,
} from '@agent/core/governance/charter-proposal';
import {
  MANUAL_STOP_TRIPWIRE,
  acceptCharterFromForm,
  parseCharterForm,
  renderAcceptanceStatement,
  statementDigest,
  viewCharter,
  type CharterView,
} from '@agent/core/governance/charter-service';
import { ensureOwnerMember } from '@agent/core/organization/member-registry';
import { listTenantProfileSlugs } from '@agent/core/organization/tenant-registry';
import { resolveConciergeDecidedBy } from './front-desk-member';
import type { ConciergeViewerContext } from './viewer-context';

type Viewer = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'memberId' | 'role'
>;

export type CharterFailure = { ok: false; status: 400 | 403 | 404 | 409; error: string };
export type CharterResult<T> = ({ ok: true } & T) | CharterFailure;

const fail = (status: CharterFailure['status'], error: string): CharterFailure => ({
  ok: false,
  status,
  error,
});

/** The viewer's tenants; a requested tenant can only narrow. */
export function charterTenants(viewer: Viewer, requested?: string | null): string[] {
  const all = listTenantProfileSlugs();
  const scoped =
    viewer.tenantSlugs === 'all' ? all : all.filter((t) => viewer.tenantSlugs.includes(t));
  return requested ? scoped.filter((t) => t === requested) : scoped;
}

function actingMember(viewer: Viewer, tenant: string) {
  if (viewer.source === 'loopback') {
    try {
      ensureOwnerMember();
    } catch {
      // Provisioning is best-effort here (same as /api/me); resolution below still fails closed.
    }
  }
  return resolveConciergeDecidedBy(viewer, tenant);
}

export interface CharterTenantEntry {
  tenant_slug: string;
  /** The viewer's membership role on this tenant, when it is decision-capable. */
  role: 'owner' | 'approver' | 'viewer' | null;
  can_create: boolean;
  /** An approver may draft limits for the owner to decide; it carries no authority. */
  can_propose: boolean;
  /** The draft waiting for the owner (visible to owner and approvers). */
  draft: CharterProposal | null;
  /** The viewer is the accountable human or a deputy of the active charter. */
  can_stop: boolean;
  charter: CharterView | null;
}

export function readCharterOverview(
  viewer: Viewer,
  requested: string | null,
  options: CharterPathOptions = {},
  now: Date = new Date(),
  locale: 'ja' | 'en' = 'ja'
): { tenants: CharterTenantEntry[]; member: { id: string; display_name: string } | null } {
  const tenants = charterTenants(viewer, requested);
  let member: { id: string; display_name: string } | null = null;
  const entries = tenants.map((tenant): CharterTenantEntry => {
    const who = actingMember(viewer, tenant);
    if (who) member = { id: who.id, display_name: who.display_name };
    const charter = findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now, options);
    const holders = charter ? [charter.accountable.actor, ...charter.accountable.deputies] : [];
    const decider = who?.role === 'owner' || who?.role === 'approver';
    return {
      tenant_slug: tenant,
      role: who?.role ?? null,
      can_create: who?.role === 'owner',
      can_propose: who?.role === 'approver',
      draft: decider ? readPendingProposal(tenant, options) : null,
      can_stop: Boolean(who && holders.includes(who.id)),
      charter: charter ? viewCharter(charter, now, options, locale) : null,
    };
  });
  return { tenants: entries, member };
}

function requireTenant(viewer: Viewer, tenant: unknown): CharterFailure | string {
  if (typeof tenant !== 'string' || !tenant) return fail(400, 'tenant_required');
  if (!charterTenants(viewer).includes(tenant)) return fail(403, 'tenant_out_of_scope');
  return tenant;
}

export function previewCharter(
  viewer: Viewer,
  rawForm: unknown,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterResult<{ statement: string; statement_sha256: string; replaces: string | null }> {
  const parsed = parseCharterForm(rawForm);
  if (!parsed.ok) return fail(400, `invalid_form: ${parsed.error}`);
  const tenant = requireTenant(viewer, parsed.form.tenant_slug);
  if (typeof tenant !== 'string') return tenant;
  const who = actingMember(viewer, tenant);
  if (!who) return fail(403, 'member_required');
  if (who.role !== 'owner') return fail(403, 'owner_required');
  const statement = renderAcceptanceStatement({
    form: parsed.form,
    accountableId: who.id,
    displayName: who.display_name,
    now,
  });
  const active = findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now, options);
  return {
    ok: true,
    statement,
    statement_sha256: statementDigest(statement),
    replaces: active?.charter_id ?? null,
  };
}

export function acceptCharterForViewer(
  viewer: Viewer,
  rawForm: unknown,
  statementSha256: unknown,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterResult<{ charter_id: string }> {
  const parsed = parseCharterForm(rawForm);
  if (!parsed.ok) return fail(400, `invalid_form: ${parsed.error}`);
  if (typeof statementSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(statementSha256)) {
    return fail(400, 'statement_digest_required');
  }
  const tenant = requireTenant(viewer, parsed.form.tenant_slug);
  if (typeof tenant !== 'string') return tenant;
  const who = actingMember(viewer, tenant);
  if (!who) return fail(403, 'member_required');
  if (who.role !== 'owner') return fail(403, 'owner_required');
  const active = findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now, options);
  try {
    const charter = acceptCharterFromForm(
      {
        form: parsed.form,
        acceptedBy: humanActor(who.id.replace(/^user:/, '')),
        displayName: who.display_name,
        holderRole: who.role,
        statementSha256,
        ...(active ? { replaces: active.charter_id } : {}),
        now,
      },
      options
    );
    clearCharterProposal(tenant, 'accepted', who.id, options, now);
    return { ok: true, charter_id: charter.charter_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('statement changed')) return fail(409, 'statement_changed');
    return fail(400, `rejected: ${message.replace(/^\[charter\]\s*/, '').slice(0, 300)}`);
  }
}

export type TripwireAction = 'stop' | 'clear' | 'retire';

/** Stop / resume / retire: the accountable human or a named deputy only. */
export function actOnCharter(
  viewer: Viewer,
  tenantRaw: unknown,
  action: TripwireAction,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterResult<{ action: TripwireAction }> {
  const tenant = requireTenant(viewer, tenantRaw);
  if (typeof tenant !== 'string') return tenant;
  const who = actingMember(viewer, tenant);
  if (!who) return fail(403, 'member_required');
  const charter = findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now, options);
  if (!charter) return fail(404, 'no_active_charter');
  if (![charter.accountable.actor, ...charter.accountable.deputies].includes(who.id)) {
    return fail(403, 'not_responsible');
  }
  const human = humanActor(who.id.replace(/^user:/, ''));
  try {
    if (action === 'stop') {
      recordTripwire(
        charter,
        MANUAL_STOP_TRIPWIRE,
        `raised from the concierge by ${who.id}`,
        options,
        now
      );
    } else if (action === 'clear') {
      clearTripwire(charter, MANUAL_STOP_TRIPWIRE, human, options, now);
    } else {
      retireCharter(charter, human, `retired from the concierge by ${who.id}`, options, now);
    }
  } catch (error) {
    return fail(
      400,
      `rejected: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`
    );
  }
  return { ok: true, action };
}

/** An approver drafts limits; only an owner can turn a draft into a charter. */
export function proposeCharter(
  viewer: Viewer,
  rawForm: unknown,
  note: unknown,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterResult<{ proposal: CharterProposal }> {
  const parsed = parseCharterForm(rawForm);
  if (!parsed.ok) return fail(400, `invalid_form: ${parsed.error}`);
  const tenant = requireTenant(viewer, parsed.form.tenant_slug);
  if (typeof tenant !== 'string') return tenant;
  const who = actingMember(viewer, tenant);
  if (!who) return fail(403, 'member_required');
  if (who.role !== 'approver') return fail(403, 'approver_required');
  const submitted = submitCharterProposal(
    {
      form: parsed.form,
      proposedBy: who.id,
      proposedByName: who.display_name,
      note,
      now,
    },
    options
  );
  if (!submitted.ok) return fail(400, `invalid_form: ${submitted.error}`);
  return { ok: true, proposal: submitted.proposal };
}

/** The owner sets a pending draft aside (accepting a charter clears it too). */
export function dismissCharterProposal(
  viewer: Viewer,
  tenantRaw: unknown,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterResult<{ dismissed: boolean }> {
  const tenant = requireTenant(viewer, tenantRaw);
  if (typeof tenant !== 'string') return tenant;
  const who = actingMember(viewer, tenant);
  if (!who) return fail(403, 'member_required');
  if (who.role !== 'owner') return fail(403, 'owner_required');
  return { ok: true, dismissed: clearCharterProposal(tenant, 'dismissed', who.id, options, now) };
}
