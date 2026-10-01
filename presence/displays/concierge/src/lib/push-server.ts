/**
 * Server-side logic behind "notify this device" (settings › notifications).
 *
 * The device belongs to the authenticated viewer: the member id is resolved
 * server-side and a client can never subscribe or unsubscribe on someone
 * else's behalf. Without VAPID keys on the server, subscribing is refused
 * rather than silently storing a device that can never be reached.
 */

import {
  addPushSubscription,
  loadWebPushConfig,
  pushSubscribedFor,
  removePushSubscription,
  type WebPushPathOptions,
} from '@agent/core/surface/web-push';
import type { ConciergeViewerContext } from './viewer-context';

type Viewer = Pick<ConciergeViewerContext, 'source' | 'memberId'>;

export type PushFailure = { ok: false; status: 400 | 403 | 409 | 503; error: string };

function isLocalOperator(viewer: Viewer): boolean {
  return viewer.source === 'loopback' && !viewer.memberId;
}

/** A stable per-viewer key. `owner_kind` separately distinguishes the local operator. */
export function pushOwner(viewer: Viewer): string | null {
  if (viewer.memberId) return viewer.memberId;
  return viewer.source === 'loopback' ? 'operator' : null;
}

export function readPushStatus(
  viewer: Viewer,
  options: WebPushPathOptions = {}
): {
  configured: boolean;
  public_key: string | null;
  subscribed: number;
  operator_eligible: boolean;
} {
  const config = loadWebPushConfig();
  const owner = pushOwner(viewer);
  const ownerKind = isLocalOperator(viewer) ? 'operator' : 'member';
  return {
    configured: config !== null,
    public_key: config?.publicKey ?? null,
    subscribed: owner ? pushSubscribedFor(owner, options, ownerKind) : 0,
    operator_eligible: isLocalOperator(viewer),
  };
}

export function subscribePush(
  viewer: Viewer,
  subscription: unknown,
  options: WebPushPathOptions = {},
  now: Date = new Date()
): { ok: true } | PushFailure {
  const owner = pushOwner(viewer);
  if (!owner) return { ok: false, status: 403, error: 'member_required' };
  if (!loadWebPushConfig()) return { ok: false, status: 503, error: 'push_not_configured' };
  const ownerKind = isLocalOperator(viewer) ? 'operator' : 'member';
  const result = addPushSubscription(owner, subscription, options, now, ownerKind);
  if (result.ok) return result;
  return {
    ok: false,
    status: result.error === 'too_many' ? 409 : 400,
    error: result.error,
  };
}

/** Operator-wide events have no tenant/member audience, so only operator devices may subscribe. */
export function subscribeOperatorPush(
  viewer: Viewer,
  subscription: unknown,
  options: WebPushPathOptions = {},
  now: Date = new Date()
): { ok: true } | PushFailure {
  if (!isLocalOperator(viewer)) {
    return { ok: false, status: 403, error: 'operator_subscription_required' };
  }
  return subscribePush(viewer, subscription, options, now);
}

export function unsubscribePush(
  viewer: Viewer,
  endpoint: unknown,
  options: WebPushPathOptions = {}
): { ok: true; removed: boolean } | PushFailure {
  const owner = pushOwner(viewer);
  if (!owner) return { ok: false, status: 403, error: 'member_required' };
  if (typeof endpoint !== 'string' || !endpoint) {
    return { ok: false, status: 400, error: 'endpoint_required' };
  }
  const ownerKind = isLocalOperator(viewer) ? 'operator' : 'member';
  return { ok: true, removed: removePushSubscription(owner, endpoint, options, ownerKind) };
}
