import { describe, expect, it } from 'vitest';
import { parsePushStatus, pushSupport, urlBase64ToBytes } from '../src/lib/push-client';

describe('push client helpers', () => {
  it('decodes a base64url VAPID key to its raw bytes', () => {
    const bytes = urlBase64ToBytes('AQID-_8');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 251, 255]);
  });

  it('needs a secure window with service worker, push and notification support', () => {
    const all = {
      hasWindow: true,
      secure: true,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
    };
    expect(pushSupport(all)).toBe('supported');
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      expect(pushSupport({ ...all, [key]: false })).toBe('unsupported');
    }
  });

  it('parses the status strictly', () => {
    expect(parsePushStatus({ ok: true, configured: true, public_key: 'k', subscribed: 1 })).toEqual(
      {
        configured: true,
        public_key: 'k',
        subscribed: 1,
      }
    );
    expect(
      parsePushStatus({ ok: true, configured: false, public_key: null, subscribed: 0 })
    ).toBeDefined();
    expect(
      parsePushStatus({ ok: true, configured: 'yes', public_key: null, subscribed: 0 })
    ).toBeUndefined();
    expect(parsePushStatus({ ok: false })).toBeUndefined();
    expect(parsePushStatus(null)).toBeUndefined();
  });
});
