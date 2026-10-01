import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  addPushSubscription,
  buildPushPayload,
  generateWebPushKeys,
  listPushSubscriptions,
  loadWebPushConfig,
  parseSubscription,
  pushKindForEvent,
  removePushSubscription,
  sendWebPushForEvent,
} from './web-push.js';

const sub = (n: number, host = 'fcm.googleapis.com') => ({
  endpoint: `https://${host}/fcm/send/device-${n}`,
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});
const config = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };

describe('web push', () => {
  let rootDir = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  beforeAll(() => {
    rootDir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `web-push-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (rootDir) safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('only accepts known push services over https, with well-formed keys', () => {
    expect(parseSubscription(sub(1))).not.toBeNull();
    expect(parseSubscription(sub(1, 'updates.push.services.mozilla.com'))).not.toBeNull();
    expect(parseSubscription(sub(1, 'evil.example.com'))).toBeNull();
    expect(parseSubscription(sub(1, 'fcm.googleapis.com.evil.com'))).toBeNull();
    expect(parseSubscription({ ...sub(1), endpoint: 'http://fcm.googleapis.com/x' })).toBeNull();
    expect(
      parseSubscription({ ...sub(1), endpoint: 'https://u:p@fcm.googleapis.com/x' })
    ).toBeNull();
    expect(
      parseSubscription({ ...sub(1), endpoint: 'https://fcm.googleapis.com:8443/x' })
    ).toBeNull();
    expect(parseSubscription({ ...sub(1), keys: { p256dh: 'a b', auth: 'x' } })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });

  it('config needs all three values and a mailto:/https subject', () => {
    expect(loadWebPushConfig({})).toBeNull();
    expect(
      loadWebPushConfig({
        KYBERION_WEB_PUSH_PUBLIC_KEY: 'a',
        KYBERION_WEB_PUSH_PRIVATE_KEY: 'b',
        KYBERION_WEB_PUSH_SUBJECT: 'ops@example.com',
      })
    ).toBeNull();
    expect(
      loadWebPushConfig({
        KYBERION_WEB_PUSH_PUBLIC_KEY: 'a',
        KYBERION_WEB_PUSH_PRIVATE_KEY: 'b',
        KYBERION_WEB_PUSH_SUBJECT: 'mailto:ops@example.com',
      })
    ).toEqual({ publicKey: 'a', privateKey: 'b', subject: 'mailto:ops@example.com' });
    const keys = generateWebPushKeys();
    expect(keys.publicKey.length).toBeGreaterThan(40);
  });

  it('subscribe is idempotent per endpoint and capped per member; only the owner unsubscribes', () => {
    const o = { rootDir };
    expect(addPushSubscription('alice', sub(1), o)).toEqual({ ok: true });
    expect(addPushSubscription('alice', sub(1), o)).toEqual({ ok: true });
    expect(listPushSubscriptions(o)).toHaveLength(1);
    for (const n of [2, 3, 4, 5]) addPushSubscription('alice', sub(n), o);
    expect(addPushSubscription('alice', sub(6), o)).toEqual({ ok: false, error: 'too_many' });
    expect(addPushSubscription('alice', { endpoint: 'nope' }, o)).toEqual({
      ok: false,
      error: 'invalid_subscription',
    });
    expect(removePushSubscription('mallory', sub(1).endpoint, o)).toBe(false);
    expect(removePushSubscription('alice', sub(1).endpoint, o)).toBe(true);
    expect(listPushSubscriptions(o)).toHaveLength(4);
  });

  it('the payload carries no private content, only a fixed line and "/"', () => {
    const payload = JSON.parse(buildPushPayload('approval_required'));
    expect(Object.keys(payload).sort()).toEqual(['body', 'title', 'url']);
    expect(payload.url).toBe('/');
    expect(pushKindForEvent('mission_completed')).toBeNull();
    expect(pushKindForEvent('approval_required')).toBe('approval_required');
  });

  it('fans out to every device, drops gone endpoints, and never throws', async () => {
    const o = { rootDir };
    const before = listPushSubscriptions(o).length;
    const sender = vi.fn(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('device-2'))
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (s.endpoint.endsWith('device-3'))
        throw Object.assign(new Error('boom'), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const result = await sendWebPushForEvent('approval_required', { config, sender, options: o });
    expect(result).toEqual({ sent: before - 2, removed: 1, failed: 1 });
    expect(listPushSubscriptions(o).some((e) => e.endpoint.endsWith('device-2'))).toBe(false);
    expect(await sendWebPushForEvent('mission_completed', { config, sender, options: o })).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
    expect(
      await sendWebPushForEvent('approval_required', { config: null, sender, options: o })
    ).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
  });
});
