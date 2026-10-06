/** Advisory, status-only setup projection. Never used to authorize an effect. */
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { assertSafeRepositoryPath, safeLstat } from '../secure-io.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import { verifyBrowserSessionToken } from '../authn-providers.js';
import {
  findMemberByExternalIdentity,
  resolveMemberByPrincipal,
  type MemberProfile,
} from '../organization/member-registry.js';
import { resolveOidcLoginConfig } from './oidc-browser-login.js';
import {
  resolveFirstJobViewer,
  type FirstJobSnapshot,
  type FirstJobReadinessStatus,
} from './first-job.js';
import { conversationRef } from './front-desk-conversation-store.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

export type FirstJobSetupAction =
  | 'none'
  | 'inspect_profile'
  | 'complete_profile'
  | 'inspect_mapping'
  | 'configure_login'
  | 'sign_in'
  | 'inspect_member_binding'
  | 'inspect_approval_scope'
  | 'inspect_baseline'
  | 'review_or_tick'
  | 'wait'
  | 'inspect_execution'
  | 'refresh';
export interface FirstJobSetupCheck<S extends string> {
  status: S;
  owner: 'user' | 'operator' | 'none';
  next_action: FirstJobSetupAction;
}
export interface FirstJobSetup {
  profile: FirstJobSetupCheck<'present' | 'missing' | 'unavailable'>;
  mapping: FirstJobSetupCheck<FirstJobReadinessStatus>;
  oidc: FirstJobSetupCheck<'configured' | 'configuration_required' | 'unavailable'>;
  browser_user: FirstJobSetupCheck<
    'verified' | 'sign_in_required' | 'binding_required' | 'unavailable'
  >;
  approval_scope: FirstJobSetupCheck<
    | 'ready'
    | 'mapping_required'
    | 'authentication_required'
    | 'owner_unavailable'
    | 'owner_mismatch'
    | 'tenant_membership_required'
    | 'unavailable'
  >;
  baseline: FirstJobSetupCheck<'unchecked'>;
  reasoning: FirstJobSetupCheck<'not_required'>;
  advancement: FirstJobSetupCheck<
    'not_started' | 'review_or_tick' | 'running' | 'receipt_verified' | 'unavailable'
  >;
}
function check<S extends string>(
  status: S,
  owner: FirstJobSetupCheck<S>['owner'] = 'none',
  next_action: FirstJobSetupAction = 'none'
): FirstJobSetupCheck<S> {
  return { status, owner, next_action };
}
function profilePresence(): FirstJobSetup['profile'] {
  // Deliberately keep the caller's role. Permission failure is not absence;
  // no protected profile contents or names are loaded or returned.
  try {
    const file = path.join(resolveActiveProfileRoot(), 'my-identity.json');
    assertSafeRepositoryPath(file, { allowMissingLeaf: true });
    try {
      return safeLstat(file).isFile()
        ? check('present')
        : check('unavailable', 'operator', 'inspect_profile');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return check('missing', 'operator', 'complete_profile');
      throw error;
    }
  } catch {
    return check('unavailable', 'operator', 'inspect_profile');
  }
}
function oidcConfiguration(): FirstJobSetup['oidc'] {
  try {
    return resolveOidcLoginConfig().config
      ? check('configured')
      : check('configuration_required', 'operator', 'configure_login');
  } catch {
    return check('unavailable', 'operator', 'configure_login');
  }
}
function browserUser(token: string): {
  status: FirstJobSetup['browser_user'];
  member?: MemberProfile;
} {
  try {
    const session = verifyBrowserSessionToken(token);
    if (!session || !/^[a-f0-9]{24}$/.test(session.sid))
      return { status: check('sign_in_required', 'user', 'sign_in') };
    // Same current external-identity binding as the browser-session provider.
    // Do not route through the audited authn resolver for this read projection,
    // and never interpret an IdP subject as a local member id.
    const member = withExecutionContext('sovereign_concierge', () =>
      findMemberByExternalIdentity(session.idp_iss, session.sub)
    );
    if (!member || member.status !== 'active')
      return { status: check('binding_required', 'operator', 'inspect_member_binding') };
    return { status: check('verified'), member };
  } catch {
    return { status: check('unavailable', 'operator', 'inspect_member_binding') };
  }
}
function approvalScope(
  authenticated: SurfaceViewerScope,
  snapshot: FirstJobSnapshot,
  member?: MemberProfile
): FirstJobSetup['approval_scope'] {
  if (!snapshot.readiness.ready) return check('mapping_required', 'operator', 'inspect_mapping');
  if (!member) return check('authentication_required', 'user', 'sign_in');
  try {
    // Recheck the exact mapping at this read, including public-only scope,
    // charter and session binding. The status is still not an authorization.
    const resolution = resolveFirstJobViewer(authenticated);
    if (!resolution.ready || conversationRef(resolution.viewer).sessionId !== snapshot.sessionId)
      return check('mapping_required', 'operator', 'inspect_mapping');
    const viewer = resolution.viewer;
    const owner = withExecutionContext('sovereign_concierge', () =>
      resolveMemberByPrincipal({
        principalId: viewer.principalId,
        memberId: viewer.memberId,
        source: 'loopback',
      })
    );
    if (!owner || owner.status !== 'active')
      return check('owner_unavailable', 'operator', 'inspect_approval_scope');
    if (owner.member_id !== member.member_id)
      return check('owner_mismatch', 'operator', 'inspect_approval_scope');
    if (
      !owner.memberships.some(
        (entry) =>
          entry.tenant_slug === viewer.tenantSlugs[0] && ['owner', 'approver'].includes(entry.role)
      )
    )
      return check('tenant_membership_required', 'operator', 'inspect_approval_scope');
    return check('ready');
  } catch {
    return check('unavailable', 'operator', 'inspect_approval_scope');
  }
}
function advancement(snapshot: FirstJobSnapshot): FirstJobSetup['advancement'] {
  if (!snapshot.readiness.ready) return check('unavailable', 'operator', 'inspect_mapping');
  // Terminal recovery history cannot block a separately approved replacement.
  const tasks = snapshot.tasks.filter((task) => task.executionStatus !== 'terminated_unstarted');
  if (
    tasks.some(
      (task) =>
        task.turnState === 'uncertain' ||
        ['blocked', 'uncertain', 'cancel_requested', 'cancelled'].includes(
          task.executionStatus ?? ''
        ) ||
        task.artifact?.currentness === 'requested_unknown'
    )
  )
    return check('unavailable', 'operator', 'inspect_execution');
  if (tasks.some((task) => task.executionStatus === 'running'))
    return check('running', 'user', 'wait');
  if (tasks.some((task) => ['queued', 'awaiting_approval'].includes(task.executionStatus ?? '')))
    // "awaiting_approval" also covers before a tick creates the approval and
    // after a decision, before dispatch. Never claim that an approval exists.
    return check('review_or_tick', 'operator', 'review_or_tick');
  if (tasks.length && tasks.every((task) => task.artifact?.verification === 'verified'))
    return check('receipt_verified');
  return tasks.length || snapshot.pending
    ? check('unavailable', 'operator', 'inspect_execution')
    : check('not_started');
}

/**
 * Called only after the existing local-host, loopback and local-admin guard.
 * Read local evidence only: no probes, login, locks, dispatch, provisioning or
 * audit writes. Ordinary outer HTTP authentication retains its own auditing.
 * Profile presence and OIDC configuration do not imply validated setup.
 */
export function readFirstJobSetup(
  authenticated: SurfaceViewerScope,
  token: string,
  snapshot: FirstJobSnapshot
): FirstJobSetup {
  const user = browserUser(token);
  return {
    profile: profilePresence(),
    mapping: check(
      snapshot.readiness.status,
      snapshot.readiness.ready ? 'none' : 'operator',
      snapshot.readiness.ready ? 'none' : 'inspect_mapping'
    ),
    oidc: oidcConfiguration(),
    browser_user: user.status,
    approval_scope: approvalScope(authenticated, snapshot, user.member),
    baseline: check('unchecked', 'operator', 'inspect_baseline'),
    reasoning: check('not_required'),
    advancement: advancement(snapshot),
  };
}
