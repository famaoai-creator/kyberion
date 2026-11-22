import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: true,
  connected: true,
  raw: null as unknown,
  loggedIn: undefined as boolean | undefined,
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
  readCalendarProviderAuthStatus: async () => ({
    ok: mocks.connected,
    available: true,
    ...(mocks.loggedIn === undefined ? {} : { logged_in: mocks.loggedIn }),
    raw: mocks.raw,
  }),
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
const { resetExternalCalendarStatusCache } =
  await import('../../../../lib/external-calendar-status');

const get = (query: string) =>
  GET(new NextRequest(`http://127.0.0.1:3050/api/calendar/external?${query}`));

describe('GET /api/calendar/external', () => {
  beforeEach(() => {
    mocks.owner = true;
    mocks.connected = true;
    mocks.raw = null;
    mocks.loggedIn = undefined;
    mocks.agendaError = null;
    resetExternalCalendarStatusCache();
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

  it('treats an installed but signed-out gws as not connected (no provider call)', async () => {
    mocks.raw = {
      auth_method: null,
      encrypted_credentials_exists: false,
      plain_credentials_exists: false,
      token_cache_exists: false,
    };
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ connected: false });
    expect(mocks.agendaCalls).toBe(0);
  });

  it('treats stored gws credentials as signed in', async () => {
    mocks.raw = { encrypted_credentials_exists: true, token_cache_exists: false };
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ connected: true });
  });

  it('reports a stored login the provider refused as login_expired (no provider call)', async () => {
    // `gws auth status` on a revoked refresh token: credentials on disk, refresh refused.
    mocks.raw = {
      encrypted_credentials_exists: true,
      token_cache_exists: true,
      token_valid: false,
      token_refresh_failed: true,
    };
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ ok: true, connected: false, login_expired: true, events: [] });
    expect(mocks.agendaCalls).toBe(0);
  });

  it('checks the login again after a failed read instead of trusting the cache', async () => {
    mocks.raw = { encrypted_credentials_exists: true, token_valid: true };
    mocks.agendaError = new Error('error sending request: connection reset');
    expect(await (await get('from=2026-11-16&to=2026-11-29')).json()).toMatchObject({
      degraded: true,
    });
    mocks.raw = {
      encrypted_credentials_exists: true,
      token_valid: false,
      token_refresh_failed: true,
    };
    expect(await (await get('from=2026-11-16&to=2026-11-29')).json()).toMatchObject({
      connected: false,
      login_expired: true,
    });
  });

  it('sees a new sign-in at once after an expired login (expired is not cached)', async () => {
    mocks.raw = {
      encrypted_credentials_exists: true,
      token_valid: false,
      token_refresh_failed: true,
    };
    expect(await (await get('from=2026-11-16&to=2026-11-29')).json()).toMatchObject({
      login_expired: true,
    });
    // The owner ran `gws auth login` and reloaded.
    mocks.raw = {
      encrypted_credentials_exists: true,
      token_valid: true,
      token_refresh_failed: false,
    };
    expect(await (await get('from=2026-11-16&to=2026-11-29')).json()).toMatchObject({
      connected: true,
    });
    expect(mocks.agendaCalls).toBe(1);
  });

  it('keeps a login whose token is merely not cached yet as signed in', async () => {
    mocks.raw = {
      encrypted_credentials_exists: true,
      token_valid: false,
      token_refresh_failed: false,
    };
    expect(await (await get('from=2026-11-16&to=2026-11-29')).json()).toMatchObject({
      connected: true,
    });
  });

  it.each([
    'Command failed: gws calendar events list\nerror[auth]: Failed to get token: invalid_grant: Bad Request',
    'Command failed: m365 request\nAADSTS700082: The refresh token has expired due to inactivity.',
    'Command failed: m365 request\ninteraction_required',
  ])('turns a refused read into login_expired without the text: %s', async (message) => {
    mocks.raw = { encrypted_credentials_exists: true, token_valid: true };
    mocks.agendaError = new Error(message);
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ ok: true, connected: false, login_expired: true, events: [] });
    expect(JSON.stringify(body)).not.toMatch(/invalid_grant|AADSTS|interaction/);
  });

  it.each([
    'Command failed: m365 request\nAADSTS700016: unauthorized_client: app not found in the tenant',
    'Command failed: gws calendar events list --params {"maxResults":401}',
    'error sending request: connection reset',
  ])('keeps a failure that is not a sign-in refusal as degraded: %s', async (message) => {
    mocks.raw = { encrypted_credentials_exists: true, token_valid: true };
    mocks.agendaError = new Error(message);
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ connected: true, degraded: true });
  });

  it('treats a status that reports no account as not connected (no provider call)', async () => {
    mocks.loggedIn = false;
    const body = await (await get('from=2026-11-16&to=2026-11-29')).json();
    expect(body).toMatchObject({ connected: false });
    expect(body.login_expired).toBeUndefined();
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
