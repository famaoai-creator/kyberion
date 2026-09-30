import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const store = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  saveCalls: 0,
}));

vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: vi.fn(() => null) }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
  })),
  conciergeErrorResponse: vi.fn(
    (error: unknown) => new Response(String(error), { status: 500 }) as never
  ),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/secure-io', () => ({
  withSensitivePathMediation: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/surface/channel-directory', () => ({
  listChannelDirectoryEntries: vi.fn(() => [
    { channel: 'slack', displayName: 'Slack', status: 'ready' },
  ]),
}));
vi.mock('@agent/core/surface/operator-notifications', () => ({
  DEFAULT_URGENT_EVENTS: ['ops_alert'],
  loadNotificationPreferences: vi.fn(() => structuredClone(store.prefs)),
  saveNotificationPreferences: vi.fn((prefs: Record<string, unknown>) => {
    // Mirror the core validator's contract for the fields under test.
    const q = prefs.quiet_hours as { start?: string; timezone?: string } | undefined;
    if (q && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(q.start ?? '') || q.timezone === 'Mars/Olympus')) {
      throw new Error('Invalid notification preferences');
    }
    store.prefs = structuredClone(prefs);
    store.saveCalls += 1;
  }),
}));

import { GET, POST } from './route.js';

function post(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json', 'accept-language': 'en' }),
    json: async () => body,
  } as unknown as NextRequest;
}
const get = () => ({ headers: new Headers() }) as unknown as NextRequest;

describe('notification-preferences route — quiet hours', () => {
  beforeEach(() => {
    store.prefs = { default_channel: { surface: 'slack', target: 'C1' } };
    store.saveCalls = 0;
  });

  it('GET exposes quiet_hours (null by default) and the default urgent events', async () => {
    const body = await (await GET(get())).json();
    expect(body.preferences).toEqual({
      default_channel: { surface: 'slack', target: 'C1' },
      quiet_hours: null,
      urgent_events: ['ops_alert'],
    });
  });

  it('saves a window on its own, without touching the delivery channel', async () => {
    const window = { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' };
    const res = await POST(post({ quiet_hours: window, urgent_events: ['ops_alert', 'question'] }));
    expect(res.status).toBe(200);
    expect(store.prefs).toMatchObject({
      default_channel: { surface: 'slack', target: 'C1' },
      quiet_hours: window,
      urgent_events: ['ops_alert', 'question'],
    });
  });

  it('quiet_hours: null turns the window off', async () => {
    store.prefs = { quiet_hours: { start: '22:00', end: '07:00', timezone: 'UTC' } };
    const res = await POST(post({ quiet_hours: null }));
    expect(res.status).toBe(200);
    expect(store.prefs.quiet_hours).toBeUndefined();
  });

  it('rejects an invalid window with 400 and writes nothing', async () => {
    const res = await POST(
      post({ quiet_hours: { start: '25:00', end: '07:00', timezone: 'UTC' } })
    );
    expect(res.status).toBe(400);
    expect(store.saveCalls).toBe(0);
    const tz = await POST(
      post({ quiet_hours: { start: '22:00', end: '07:00', timezone: 'Mars/Olympus' } })
    );
    expect(tz.status).toBe(400);
  });

  it('still requires the known-keys contract (unknown keys are rejected)', async () => {
    const res = await POST(post({ quiet_hours: null, nonsense: 1 }));
    expect(res.status).toBe(400);
  });
});
