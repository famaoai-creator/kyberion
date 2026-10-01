/**
 * Browser-side helpers for "notify this device". Pure where possible so the
 * parts that matter (key decoding, support detection) are testable without a
 * browser.
 */

/** VAPID public keys are base64url; `PushManager.subscribe` wants the raw bytes. */
export function urlBase64ToBytes(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export type PushSupport = 'supported' | 'unsupported';

export function pushSupport(env: {
  hasWindow: boolean;
  secure: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}): PushSupport {
  return env.hasWindow &&
    env.secure &&
    env.hasServiceWorker &&
    env.hasPushManager &&
    env.hasNotification
    ? 'supported'
    : 'unsupported';
}

export type PushStatusResponse = {
  configured: boolean;
  public_key: string | null;
  subscribed: number;
};

export function parsePushStatus(value: unknown): PushStatusResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || typeof v.configured !== 'boolean' || typeof v.subscribed !== 'number') {
    return undefined;
  }
  if (v.public_key !== null && typeof v.public_key !== 'string') return undefined;
  return {
    configured: v.configured,
    public_key: v.public_key as string | null,
    subscribed: v.subscribed,
  };
}
