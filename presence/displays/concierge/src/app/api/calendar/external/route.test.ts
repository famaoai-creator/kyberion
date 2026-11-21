import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: true,
  connected: true,
  agendaError: null as Error | null,
  agendaCalls: 0,
}));

vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: { role: 'localadmin', source: 'loopback' } }),
}));
vi.mock('../../../../lib/installation-access', () => ({
  resolveConciergeInstallationAccess: () => ({ allowed: mocks.owner }),
}));
vi.mock('@agent/core/meeting/calendar-workflow', () => ({
  normalizeCalendarProviderId: () => 'google-workspace',
  readCalendarProviderAuthStatus: async () => ({ ok: mocks.connected, available: true, raw: null }),
  listCalendarAgenda: async () => {
    mocks.agendaCalls += 1;
    if (mocks.agendaError) throw mocks.agendaError;
    return {
      total_items: 3,
      events: [
        {
          id: 'e1',
          summary: 'Customer call',
          start: '2026-11-24T01:00:00Z',
          end: '2026-11-24T02:00:00Z',
          status: 'confirmed',
          html_link: 'https://calendar.example/e1',
        },
        {
          id: 'e2',
          summary: 'Holiday',
          start: '2026-11-23',
          end: '2026-11-24',
          status: 'confirmed',
        },
        { id: 'e3', summary: 'Dropped', start: '2026-11-25T01:00:00Z', status: 'cancelled' },
      ],
    };
  },
}));

const { GET } = await import('./route');

const get = (query: string) =>
  GET(new NextRequest(`http://127.0.0.1:3050/api/calendar/external?${query}`));

describe('GET /api/calendar/external', () => {
  beforeEach(() => {
    mocks.owner = true;
    mocks.connected = true;
    mocks.agendaError = null;
    mocks.agendaCalls = 0;
  });

  it('gives the installation owner their events (cancelled dropped, all-day marked)', async () => {
    const response = await get('from=2026-11-16&to=2026-11-29');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, connected: true, provider: 'google-workspace' });
    expect(body.events).toEqual([
      {
        id: 'e1',
        title: 'Customer call',
        start: '2026-11-24T01:00:00Z',
        end: '2026-11-24T02:00:00Z',
        allDay: false,
        link: 'https://calendar.example/e1',
      },
      { id: 'e2', title: 'Holiday', start: '2026-11-23', end: '2026-11-24', allDay: true },
    ]);
  });

  it('refuses anyone but the installation owner without touching the provider', async () => {
    mocks.owner = false;
    const response = await get('from=2026-11-16&to=2026-11-29');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_code: 'installation_owner_required' });
    expect(mocks.agendaCalls).toBe(0);
  });

  it('calls no provider when no login is connected', async () => {
    mocks.connected = false;
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ ok: true, connected: false, events: [] });
    expect(mocks.agendaCalls).toBe(0);
  });

  it('reports a provider failure as degraded with a fixed message', async () => {
    mocks.agendaError = new Error('token expired for user@example.com');
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ ok: true, connected: true, degraded: true, events: [] });
    expect(JSON.stringify(body)).not.toContain('example.com');
  });

  it.each([
    'from=2026-11-31&to=2026-12-01',
    'from=2026-12-01&to=2026-11-01',
    'from=2026-01-01&to=2026-12-31',
    '',
  ])('refuses the range %s with 400', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(mocks.agendaCalls).toBe(0);
  });
});
