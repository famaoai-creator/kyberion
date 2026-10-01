/**
 * Hand an invite over by e-mail — as a DRAFT in the inviter's own mail
 * backend, never as a send. Sending to an outside person is the inviter's act:
 * they open the draft, read it and press send themselves, so this adds no new
 * unattended outbound path and no governance bypass.
 *
 * The code is the whole secret. It is used only to build the join link inside
 * the draft; it is never logged or echoed back, and the viewer must be an
 * owner or approver of the tenant the code names.
 */

import { t } from '@agent/core/t';
import { resolveConciergeDecidedBy } from './front-desk-member';
import { charterTenants } from './charter-server';
import { inviteJoinPath } from './invite-view';
import type { ConciergeViewerContext } from './viewer-context';

type Viewer = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'memberId' | 'role' | 'principal'
>;

export type InviteEmailResult =
  { ok: true; draft: 'created' | 'unavailable' } | { ok: false; status: 400 | 403; error: string };

/** Deliberately plain: one address, no display name, no separators that could add recipients. */
const EMAIL = /^[^\s@,;<>()"']{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const CODE = /^([a-z0-9][a-z0-9-]*)~[A-Za-z0-9_-]+~[A-Za-z0-9_-]+$/;

export interface InviteEmailDeps {
  createDraft: (params: { to: string; subject: string; body: string }) => Promise<boolean>;
}

const defaultDeps: InviteEmailDeps = {
  // The available email bridge adapters are process-wide (Mail.app / SMTP)
  // and do not prove which human account owns the resulting draft. Do not
  // fall back to a host account for a member's invitation; an owner-bound
  // adapter can be wired here once the integration exposes that identity.
  createDraft: async () => false,
};

export async function createInviteEmailDraft(
  viewer: Viewer,
  body: { tenant_slug?: unknown; code?: unknown; email?: unknown },
  origin: string,
  locale: 'ja' | 'en',
  deps: InviteEmailDeps = defaultDeps
): Promise<InviteEmailResult> {
  const tenant = typeof body.tenant_slug === 'string' ? body.tenant_slug : '';
  const code = typeof body.code === 'string' ? body.code : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!tenant || !EMAIL.test(email)) return { ok: false, status: 400, error: 'invalid_email' };
  if (CODE.exec(code)?.[1] !== tenant) return { ok: false, status: 400, error: 'invalid_code' };
  if (!charterTenants(viewer).includes(tenant)) {
    return { ok: false, status: 403, error: 'tenant_out_of_scope' };
  }
  const inviter = resolveConciergeDecidedBy(viewer, tenant);
  if (!inviter || (inviter.role !== 'owner' && inviter.role !== 'approver')) {
    return { ok: false, status: 403, error: 'member_required' };
  }
  const link = `${origin}${inviteJoinPath(code)}`;
  const params = { tenant, inviter: inviter.display_name, link };
  const created = await deps.createDraft({
    to: email,
    subject: t('invite.email_subject', params, locale),
    body: t('invite.email_body', params, locale),
  });
  return { ok: true, draft: created ? 'created' : 'unavailable' };
}
