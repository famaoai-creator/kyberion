/**
 * Web Push for the concierge PWA — a phone buzz that says "something is waiting
 * for you", never what.
 *
 *  - Payloads are CONTENT-FREE by construction: a fixed title and a fixed line
 *    per event kind, opening `/`. No title, id, tenant or amount ever reaches a
 *    push service (Google / Mozilla / Apple relay the payload's existence and
 *    timing, so the text itself carries nothing confidential).
 *  - Subscription endpoints are client-supplied URLs the server will POST to, so
 *    only the known browser push services are accepted (no SSRF through here).
 *  - VAPID keys live in the environment like every other secret
 *    (`KYBERION_WEB_PUSH_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT`); without them
 *    nothing is sent and subscribing is refused.
 *  - A gone endpoint (404 / 410) is dropped on the spot.
 *
 * Subscriptions are runtime state under `active/shared/runtime/web-push/`.
 */

import * as path from 'node:path';
import webpush from 'web-push';
import { logger } from '../core.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import * as pathResolver from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { t } from '../t.js';

export interface WebPushPathOptions {
  rootDir?: string;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredPushSubscription extends WebPushSubscription {
  member_id: string;
  created_at: string;
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const MAX_PER_MEMBER = 5;
const MAX_TOTAL = 500;
const MAX_ENDPOINT = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The browser push services; anything else is refused (the server POSTs to this host). */
const PUSH_HOSTS: ReadonlyArray<RegExp> = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
];

export function loadWebPushConfig(env?: Record<string, string | undefined>): WebPushConfig | null {
  const read = (name: string) =>
    getRegisteredEnvText(name, env ? { env } : {})?.trim() || undefined;
  const publicKey = read('KYBERION_WEB_PUSH_PUBLIC_KEY');
  const privateKey = read('KYBERION_WEB_PUSH_PRIVATE_KEY');
  const subject = read('KYBERION_WEB_PUSH_SUBJECT');
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function generateWebPushKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/** A subscription as the browser's `PushSubscription.toJSON()` gives it, or null. */
export function parseSubscription(raw: unknown): WebPushSubscription | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof r.endpoint !== 'string' || r.endpoint.length > MAX_ENDPOINT) return null;
  let url: URL;
  try {
    url = new URL(r.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (!PUSH_HOSTS.some((pattern) => pattern.test(url.hostname))) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (typeof p256dh !== 'string' || !BASE64URL.test(p256dh) || p256dh.length > 200) return null;
  if (typeof auth !== 'string' || !BASE64URL.test(auth) || auth.length > 100) return null;
  return { endpoint: r.endpoint, keys: { p256dh, auth } };
}

function storeFile(options: WebPushPathOptions): string {
  const root = options.rootDir ?? pathResolver.rootDir();
  return assertSafeRepositoryPath(
    path.join(root, 'active', 'shared', 'runtime', 'web-push', 'subscriptions.json'),
    { allowMissingLeaf: true, rootDir: options.rootDir }
  );
}

export function listPushSubscriptions(options: WebPushPathOptions = {}): StoredPushSubscription[] {
  const file = storeFile(options);
  if (!safeExistsSync(file)) return [];
  const parsed = parseSafeJsonInput(readTextFile(file), 'web push subscriptions');
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is StoredPushSubscription => {
    const sub = parseSubscription(entry);
    return sub !== null && typeof (entry as StoredPushSubscription).member_id === 'string';
  });
}

function save(entries: StoredPushSubscription[], options: WebPushPathOptions): void {
  const file = storeFile(options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8' });
}

export type SubscribeResult =
  { ok: true } | { ok: false; error: 'invalid_subscription' | 'too_many' };

/** Idempotent per endpoint; a device re-subscribing under another member moves to that member. */
export function addPushSubscription(
  memberId: string,
  raw: unknown,
  options: WebPushPathOptions = {},
  now: Date = new Date()
): SubscribeResult {
  const sub = parseSubscription(raw);
  if (!sub) return { ok: false, error: 'invalid_subscription' };
  const others = listPushSubscriptions(options).filter((e) => e.endpoint !== sub.endpoint);
  const mine = others.filter((e) => e.member_id === memberId).length;
  if (mine >= MAX_PER_MEMBER || others.length >= MAX_TOTAL) {
    return { ok: false, error: 'too_many' };
  }
  save([...others, { ...sub, member_id: memberId, created_at: now.toISOString() }], options);
  return { ok: true };
}

/** Only the member's own subscription can be removed by them. */
export function removePushSubscription(
  memberId: string,
  endpoint: string,
  options: WebPushPathOptions = {}
): boolean {
  const all = listPushSubscriptions(options);
  const next = all.filter((e) => !(e.endpoint === endpoint && e.member_id === memberId));
  if (next.length === all.length) return false;
  save(next, options);
  return true;
}

export function pushSubscribedFor(memberId: string, options: WebPushPathOptions = {}): number {
  return listPushSubscriptions(options).filter((e) => e.member_id === memberId).length;
}

/** True when this event would reach at least one device (keys set, a device subscribed, event buzzes). */
export function webPushWouldDeliver(event: string, options: WebPushPathOptions = {}): boolean {
  return (
    pushKindForEvent(event) !== null &&
    loadWebPushConfig() !== null &&
    listPushSubscriptions(options).length > 0
  );
}

export type PushEventKind = 'approval_required' | 'question' | 'decision_digest' | 'other';

const KIND_BODY: Record<PushEventKind, Parameters<typeof t>[0]> = {
  approval_required: 'webpush.body_approval_required',
  question: 'webpush.body_question',
  decision_digest: 'webpush.body_digest',
  other: 'webpush.body_other',
};

/** The only events that buzz a phone; everything else stays in the inbox. */
export function pushKindForEvent(event: string): PushEventKind | null {
  if (event === 'approval_required' || event === 'question' || event === 'decision_digest') {
    return event;
  }
  if (event === 'ops_alert') return 'other';
  return null;
}

export function buildPushPayload(kind: PushEventKind): string {
  return JSON.stringify({ title: t('webpush.title'), body: t(KIND_BODY[kind]), url: '/' });
}

export type PushSender = (
  subscription: WebPushSubscription,
  payload: string,
  config: WebPushConfig
) => Promise<{ statusCode: number }>;

const defaultSender: PushSender = async (subscription, payload, config) => {
  const result = await webpush.sendNotification(subscription, payload, {
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    },
    TTL: 60 * 60,
    urgency: 'normal',
    timeout: 10_000,
  });
  return { statusCode: result.statusCode };
};

export interface FanOutResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Buzz every subscribed device (content-free). Never throws: a failing push
 * service must not break the event that triggered it.
 */
export async function sendWebPushForEvent(
  event: string,
  deps: {
    config?: WebPushConfig | null;
    sender?: PushSender;
    options?: WebPushPathOptions;
  } = {}
): Promise<FanOutResult> {
  const result: FanOutResult = { sent: 0, removed: 0, failed: 0 };
  const kind = pushKindForEvent(event);
  if (!kind) return result;
  const config = deps.config === undefined ? loadWebPushConfig() : deps.config;
  if (!config) return result;
  const options = deps.options ?? {};
  const sender = deps.sender ?? defaultSender;
  const subscriptions = listPushSubscriptions(options);
  if (subscriptions.length === 0) return result;
  const payload = buildPushPayload(kind);
  const gone = new Set<string>();
  await Promise.all(
    subscriptions.map(async (entry) => {
      try {
        await sender({ endpoint: entry.endpoint, keys: entry.keys }, payload, config);
        result.sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          gone.add(entry.endpoint);
        } else {
          result.failed += 1;
          logger.warn(
            `[web-push] delivery failed (${status ?? 'network'}) — the device may be offline | it is retried on the next event`
          );
        }
      }
    })
  );
  if (gone.size > 0) {
    save(
      listPushSubscriptions(options).filter((e) => !gone.has(e.endpoint)),
      options
    );
    result.removed = gone.size;
  }
  return result;
}
