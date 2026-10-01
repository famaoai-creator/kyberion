import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { pushOwner, readPushStatus, subscribePush, unsubscribePush } from './push-server';

const sub = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/dev-${n}`,
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});
const alice = { source: 'token', memberId: 'alice' } as never;
const bob = { source: 'token', memberId: 'bob' } as never;
const stranger = { source: 'anonymous' } as never;

describe('push-server', () => {
  let root = '';
  const saved: Record<string, string | undefined> = {};
  const opts = () => ({ rootDir: root });
  beforeAll(() => {
    root = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp', `push-srv-${randomUUID()}`);
    for (const k of ['KYBERION_PERSONA', 'MISSION_ROLE']) saved[k] = process.env[k];
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of [
      'KYBERION_WEB_PUSH_PUBLIC_KEY',
      'KYBERION_WEB_PUSH_PRIVATE_KEY',
      'KYBERION_WEB_PUSH_SUBJECT',
    ]) {
      delete process.env[k];
    }
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    process.env.KYBERION_WEB_PUSH_PUBLIC_KEY = 'pub-key';
    process.env.KYBERION_WEB_PUSH_PRIVATE_KEY = 'priv-key';
    process.env.KYBERION_WEB_PUSH_SUBJECT = 'mailto:ops@example.com';
  });

  it('the owner is the server-resolved member (or the local operator on loopback)', () => {
    expect(pushOwner(alice)).toBe('alice');
    expect(pushOwner({ source: 'loopback' } as never)).toBe('operator');
    expect(pushOwner(stranger)).toBeNull();
  });

  it('refuses to subscribe without server keys, and never exposes the private key', () => {
    delete process.env.KYBERION_WEB_PUSH_PRIVATE_KEY;
    expect(subscribePush(alice, sub(1), opts())).toMatchObject({ ok: false, status: 503 });
    expect(readPushStatus(alice, opts())).toMatchObject({ configured: false, public_key: null });
    process.env.KYBERION_WEB_PUSH_PRIVATE_KEY = 'priv-key';
    const status = readPushStatus(alice, opts());
    expect(status).toMatchObject({ configured: true, public_key: 'pub-key' });
    expect(JSON.stringify(status)).not.toContain('priv-key');
  });

  it('subscribes the viewer only; another member cannot remove it', () => {
    expect(subscribePush(stranger, sub(1), opts())).toMatchObject({ ok: false, status: 403 });
    expect(subscribePush(alice, { endpoint: 'https://evil.example.com/x' }, opts())).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(subscribePush(alice, sub(1), opts())).toEqual({ ok: true });
    expect(readPushStatus(alice, opts()).subscribed).toBe(1);
    expect(readPushStatus(bob, opts()).subscribed).toBe(0);
    expect(unsubscribePush(bob, sub(1).endpoint, opts())).toEqual({ ok: true, removed: false });
    expect(unsubscribePush(alice, sub(1).endpoint, opts())).toEqual({ ok: true, removed: true });
    expect(unsubscribePush(alice, 3, opts())).toMatchObject({ ok: false, status: 400 });
  });
});
