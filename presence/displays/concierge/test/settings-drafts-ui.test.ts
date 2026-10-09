import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { ProfileSectionProps } from '../src/app/settings/sections/ProfileSection';
import type { NotificationsSectionProps } from '../src/app/settings/sections/NotificationsSection';
import type { ServicesSectionProps } from '../src/app/settings/sections/ServicesSection';
import {
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';

const captured = vi.hoisted(() => ({
  profile: null as ProfileSectionProps | null,
  notifications: null as NotificationsSectionProps | null,
  services: null as ServicesSectionProps | null,
}));
vi.mock('../src/app/settings/sections/ProfileSection', () => ({
  ProfileSection: (props: ProfileSectionProps) => {
    captured.profile = props;
    return null;
  },
}));
vi.mock('../src/app/settings/sections/NotificationsSection', () => ({
  NotificationsSection: (props: NotificationsSectionProps) => {
    captured.notifications = props;
    return null;
  },
}));
vi.mock('../src/app/settings/sections/ServicesSection', () => ({
  ServicesSection: (props: ServicesSectionProps) => {
    captured.services = props;
    return null;
  },
}));
vi.mock('../src/app/settings/sections/MembersSection', () => ({ MembersSection: () => null }));
vi.mock('../src/app/settings/sections/VoiceSection', () => ({ VoiceSection: () => null }));
vi.mock('../src/app/settings/sections/RecordingConsentSection', () => ({
  RecordingConsentSection: () => null,
}));
vi.mock('../src/app/settings/sections/PluginsSection', () => ({ PluginsSection: () => null }));
vi.mock('../src/app/settings/sections/AdvancedSection', () => ({ AdvancedSection: () => null }));
vi.mock('../src/app/settings/sections/DisplaySection', () => ({ DisplaySection: () => null }));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({
    locale: 'en',
    setLocale: () => {},
    t: (key: string, params?: Record<string, unknown>) =>
      key + (params ? JSON.stringify(params) : ''),
  }),
}));
import SettingsPage from '../src/app/settings/page';

const setup = () => ({
  ok: true,
  setup: {
    surface_roles: [],
    active_surfaces: [],
    reasoning_mode: 'stub',
    model_tiers: {},
    profile: {
      name: 'Saved name',
      language: 'en',
      interaction_style: 'Concierge',
      primary_domain: 'operations',
      vision: 'Saved vision',
      agent_id: 'agent',
      tenant_slug: 'alpha',
      onboarding_complete: true,
      avatar_registered: false,
      voice_profiles: [],
    },
    service_catalog: [
      { id: 'browser', label: 'Browser', auth: 'session', configured: true },
      { id: 'slack', label: 'Slack', auth: 'oauth', configured: true },
    ],
    diagnostics: [],
    capabilities: [],
    tenant: { active_slug: 'alpha', runtime_bound: true, catalog: [] },
    agent_management: { configured: null, durable_identities: [] },
  },
});
const me = () => ({
  ok: true,
  member: { member_id: 'alice', source: 'token', registered: true, display_name: 'Alice' },
  viewing: null,
  tenants: [],
  write_tenant: 'alpha',
  can_switch: false,
  available_operations: [] as string[],
  onboarded: true,
});
const preferences = (target = 'old-channel') => ({
  ok: true,
  preferences: { default_channel: { surface: 'slack', target } },
  channels: [{ surface: 'slack', display_name: 'Slack', status: 'ready' }],
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
type Respond = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function serve(respond?: Respond) {
  const storedSetup = setup();
  let storedPreferences = preferences();
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const override = respond?.(url, init);
      if (override) return override;
      if (url === '/api/me') return json(me());
      if (url === '/api/setup') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            draft: { identity: typeof storedSetup.setup.profile };
          };
          Object.assign(storedSetup.setup.profile, body.draft.identity);
          return json({
            ok: true,
            onboarding: { ok: true, applied_at: '2026-10-08', artifacts: [], warnings: [] },
          });
        }
        return json(storedSetup);
      }
      if (url === '/api/notification-preferences') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { surface: string; channel: string };
          storedPreferences = preferences(body.channel);
        }
        return json(storedPreferences);
      }
      return json({ ok: false }, 404);
    })
  );
}
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom({ sessionStorage: { getItem: () => null } });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  captured.profile = null;
  captured.notifications = null;
  captured.services = null;
});
afterAll(() => dom.restore());
async function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SettingsPage)));
  expect(captured.profile).not.toBeNull();
  return {
    container,
    text: () => serializeFake(container),
    click: async (action: string) => {
      const button = container.querySelector('[data-action-id="' + action + '"]');
      if (!button) throw new Error('Missing action ' + action);
      await act(async () => {
        fireEvent(button, 'click');
      });
    },
  };
}

describe('settings page draft preservation', () => {
  it('saving notifications preserves unsaved profile and service edits', async () => {
    serve();
    await mount();
    await act(async () => {
      captured.profile!.setProfile({ ...captured.profile!.profile, name: 'Unsaved name' });
      captured.services!.setServices(['browser']);
      captured.notifications!.setNotif({ surface: 'slack', target: 'new-channel' });
    });
    await act(async () => captured.notifications!.onSaveNotification());
    expect(captured.profile!.profile.name).toBe('Unsaved name');
    expect(captured.services!.services).toEqual(['browser']);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const receipt = () =>
  json({
    ok: true,
    onboarding: { ok: true, applied_at: '2026-10-08', artifacts: [], warnings: [] },
  });
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const profileName = async (name: string) =>
  act(async () => captured.profile!.setProfile({ ...captured.profile!.profile, name }));
const notificationTarget = async (target: string) =>
  act(async () => captured.notifications!.setNotif({ surface: 'slack', target }));

describe('settings submitted snapshots and outcomes', () => {
  it.each(['Newer edit', 'Saved name'])(
    'keeps an edit made during profile save: %s',
    async (newer) => {
      const pending = deferred<Response>();
      let saving = false;
      serve((url, init) => {
        if (url === '/api/setup' && init?.method === 'POST') {
          saving = true;
          return pending.promise;
        }
        if (url === '/api/setup' && saving) {
          const data = setup();
          data.setup.profile.name = 'Submitted';
          return json(data);
        }
      });
      const view = await mount();
      await profileName('Submitted');
      await act(async () => captured.profile!.onSaveProfile());
      expect(posts()).toHaveLength(1);
      expect(view.text()).toContain('data-state=saving');
      await profileName(newer);
      await act(async () => pending.resolve(receipt()));
      expect(captured.profile!.profile.name).toBe(newer);
      expect(view.text()).toContain('data-state=dirty');
      await view.click('settings.discard');
      expect(captured.profile!.profile.name).toBe('Submitted');
    }
  );

  it('preserves newer notification edits and discards to the acknowledged channel', async () => {
    const pending = deferred<Response>();
    let saving = false;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && init?.method === 'POST') {
        saving = true;
        return pending.promise;
      }
      if (url === '/api/notification-preferences' && saving) return json(preferences('submitted'));
    });
    const view = await mount();
    await notificationTarget('submitted');
    await act(async () => captured.notifications!.onSaveNotification());
    await notificationTarget('newer');
    await act(async () => pending.resolve(json(preferences('submitted'))));
    expect(captured.notifications!.notif.target).toBe('newer');
    await view.click('settings.discard');
    expect(captured.notifications!.notif.target).toBe('submitted');
  });

  it('keeps successful receipt and edits visible when the follow-up read fails', async () => {
    let saved = false;
    serve((url, init) => {
      if (url === '/api/setup' && init?.method === 'POST') {
        saved = true;
        return receipt();
      }
      if (url === '/api/setup' && saved) return json({ ok: false }, 500);
    });
    const view = await mount();
    await profileName('Submitted');
    await act(async () => captured.profile!.onSaveProfile());
    expect(captured.profile!.profile.name).toBe('Submitted');
    expect(view.text()).toContain('setup.draft_refresh_failed');
    await profileName('Newer');
    await view.click('settings.discard');
    expect(captured.profile!.profile.name).toBe('Submitted');
  });

  it.each([
    {},
    { ok: false },
    { ok: true },
    { ok: true, onboarding: { ok: false } },
    { ok: true, onboarding: { ok: true, applied_at: 'x', artifacts: [], warnings: 'bad' } },
  ])('does not acknowledge malformed profile receipt %#', async (body) => {
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST' ? json(body) : undefined
    );
    const view = await mount();
    await profileName('Unsaved');
    await act(async () => captured.profile!.onSaveProfile());
    expect(view.text()).toContain('setup.draft_save_unconfirmed');
    expect(view.text()).toContain('data-state=dirty');
    await view.click('settings.discard');
    expect(captured.profile!.profile.name).toBe('Saved name');
  });

  it.each([
    {},
    { ok: true },
    { ok: true, preferences: { default_channel: null } },
    preferences('different'),
  ])('does not acknowledge malformed or mismatched notification receipt %#', async (body) => {
    serve((url, init) =>
      url === '/api/notification-preferences' && init?.method === 'POST' ? json(body) : undefined
    );
    const view = await mount();
    await notificationTarget('unsaved');
    await act(async () => captured.notifications!.onSaveNotification());
    expect(view.text()).toContain('setup.draft_save_unconfirmed');
    await view.click('settings.discard');
    expect(captured.notifications!.notif.target).toBe('old-channel');
  });

  it.each([false, true])(
    'retains independent baselines after partial grouped save (profile succeeds %s)',
    async (profileSucceeds) => {
      serve((url, init) => {
        if (init?.method !== 'POST') return undefined;
        if ((url === '/api/setup') !== profileSucceeds) return json({ ok: false }, 500);
      });
      const view = await mount();
      await profileName('Submitted');
      await notificationTarget('new-channel');
      await view.click('settings.save');
      expect(posts()).toHaveLength(2);
      expect(view.text()).toContain('setup.draft_batch_incomplete');
      await view.click('settings.discard');
      expect(captured.profile!.profile.name).toBe(profileSucceeds ? 'Submitted' : 'Saved name');
      expect(captured.notifications!.notif.target).toBe(
        profileSucceeds ? 'old-channel' : 'new-channel'
      );
    }
  );

  it('validates the notification target before starting a grouped save', async () => {
    serve();
    const view = await mount();
    await profileName('Unsaved');
    await notificationTarget('   ');
    await view.click('settings.save');
    expect(posts()).toHaveLength(0);
    expect(view.text()).toContain('api.notification_target');
    expect(view.text()).toContain('data-state=error');
  });

  it('rejects same-turn repeated saves and keeps discard disabled until settlement', async () => {
    const pending = deferred<Response>();
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST' ? pending.promise : undefined
    );
    const view = await mount();
    await profileName('Submitted');
    await act(async () => {
      captured.profile!.onSaveProfile();
      captured.profile!.onSaveProfile();
      captured.notifications!.onSaveNotification();
    });
    expect(posts()).toHaveLength(1);
    const discard = view.container.querySelector('[data-action-id="settings.discard"]');
    expect(discard?.getAttribute('disabled')).not.toBeNull();
    await act(async () => pending.resolve(receipt()));
  });
});

describe('settings identity, auth and stale-response fences', () => {
  it.each(['principal', 'write-tenant', 'role'])(
    'clears drafts without submitting when observed %s changes',
    async (change) => {
      let changed = false;
      serve((url) => {
        if (url !== '/api/me') return undefined;
        const value = me();
        if (changed) {
          if (change === 'principal') value.member.member_id = 'bob';
          else if (change === 'write-tenant') value.write_tenant = 'beta';
          else value.available_operations = ['different-role'];
        }
        return json(value);
      });
      const view = await mount();
      await profileName('Private draft');
      changed = true;
      await act(async () => captured.profile!.onSaveProfile());
      expect(posts()).toHaveLength(0);
      expect(view.text()).toContain('setup.draft_context_changed');
      expect(view.container.querySelector('.settings-page')).toBeNull();
      expect(view.text()).not.toContain('Private draft');
    }
  );

  it.each([401, 403])('clears drafts and stops the grouped batch on HTTP %s', async (status) => {
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST'
        ? new Response('auth failure', { status })
        : undefined
    );
    const view = await mount();
    await profileName('Private draft');
    await notificationTarget('Private target');
    await view.click('settings.save');
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('setup.draft_context_changed');
    expect(view.container.querySelector('.settings-page')).toBeNull();
    expect(view.text()).not.toContain('Private draft');
    expect(view.text()).not.toContain('Private target');
  });

  it('ignores a successful late body when the viewer changes and never sends the remaining batch', async () => {
    const pending = deferred<unknown>();
    let changed = false;
    serve((url, init) => {
      if (url === '/api/me') {
        const value = me();
        if (changed) value.member.member_id = 'bob';
        return json(value);
      }
      if (url === '/api/setup' && init?.method === 'POST')
        return { ok: true, status: 200, json: () => pending.promise } as Response;
    });
    const view = await mount();
    await profileName('Private draft');
    await notificationTarget('Private target');
    await view.click('settings.save');
    expect(posts()).toHaveLength(1);
    changed = true;
    await act(async () =>
      pending.resolve({
        ok: true,
        onboarding: { ok: true, applied_at: 'x', artifacts: [], warnings: [] },
      })
    );
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('setup.draft_context_changed');
    expect(view.text()).not.toContain('setup.onboarding_saved');
  });

  it('keeps drafts and sends nothing when the identity check is malformed', async () => {
    let bad = false;
    serve((url) => (url === '/api/me' && bad ? json({ ok: true }) : undefined));
    const view = await mount();
    await profileName('Unsaved');
    bad = true;
    await act(async () => captured.profile!.onSaveProfile());
    expect(posts()).toHaveLength(0);
    expect(captured.profile!.profile.name).toBe('Unsaved');
    expect(view.text()).toContain('setup.draft_context_unavailable');
  });

  it('does not overwrite notification edits made before the initial preferences load completes', async () => {
    const pending = deferred<Response>();
    let first = true;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && !init?.method && first) {
        first = false;
        return pending.promise;
      }
    });
    await mount();
    await notificationTarget('Typed early');
    await act(async () => pending.resolve(json(preferences())));
    expect(captured.notifications!.notif.target).toBe('Typed early');
  });

  it('ignores a stale initial preferences response arriving after a successful save', async () => {
    const pending = deferred<Response>();
    let first = true;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && !init?.method && first) {
        first = false;
        return pending.promise;
      }
    });
    await mount();
    await notificationTarget('new-channel');
    await act(async () => captured.notifications!.onSaveNotification());
    expect(captured.notifications!.notif.target).toBe('new-channel');
    await act(async () => pending.resolve(json(preferences('stale'))));
    expect(captured.notifications!.notif.target).toBe('new-channel');
  });

  it('clears restored page drafts and fences a late successful save after BFCache restoration', async () => {
    const pending = deferred<Response>();
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST' ? pending.promise : undefined
    );
    const view = await mount();
    await profileName('Private draft');
    await act(async () => captured.profile!.onSaveProfile());
    await act(async () => {
      fireEvent(dom.windowEvents, 'pageshow', { persisted: true });
    });
    await act(async () => pending.resolve(receipt()));
    expect(view.text()).toContain('setup.draft_context_changed');
    expect(posts()).toHaveLength(1);
    expect(view.text()).not.toContain('setup.onboarding_saved');
  });

  it('does not continue grouped mutations after the page unmounts', async () => {
    const pending = deferred<Response>();
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST' ? pending.promise : undefined
    );
    const view = await mount();
    await profileName('Private draft');
    await notificationTarget('Private target');
    await view.click('settings.save');
    unmount?.();
    unmount = undefined;
    await act(async () => pending.resolve(receipt()));
    expect(posts()).toHaveLength(1);
  });

  it('keeps edits on network rejection and never automatically retries', async () => {
    serve((url, init) =>
      url === '/api/setup' && init?.method === 'POST'
        ? Promise.reject(new Error('network failed'))
        : undefined
    );
    const view = await mount();
    await profileName('Unsaved');
    await act(async () => captured.profile!.onSaveProfile());
    expect(captured.profile!.profile.name).toBe('Unsaved');
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('setup.draft_save_unconfirmed');
  });
});

describe('initial notification baseline interleavings', () => {
  it('lets an unrelated profile save finish without orphaning the pending notification baseline', async () => {
    const pending = deferred<Response>();
    let first = true;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && !init?.method && first) {
        first = false;
        return pending.promise;
      }
    });
    const view = await mount();
    await notificationTarget('Typed early');
    await profileName('Submitted');
    await act(async () => captured.profile!.onSaveProfile());
    await act(async () => pending.resolve(json(preferences())));
    expect(captured.notifications!.notif.target).toBe('Typed early');
    expect(view.text()).toContain('data-state=dirty');
    await view.click('settings.discard');
    expect(captured.notifications!.notif.target).toBe('old-channel');
    expect(captured.profile!.profile.name).toBe('Submitted');
  });
  it('includes an explicitly edited notification in Save All before the initial read finishes', async () => {
    const pending = deferred<Response>();
    let first = true;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && !init?.method && first) {
        first = false;
        return pending.promise;
      }
    });
    const view = await mount();
    await notificationTarget('new-channel');
    await profileName('Submitted');
    await view.click('settings.save');
    expect(posts()).toHaveLength(2);
    await act(async () => pending.resolve(json(preferences('stale'))));
    expect(captured.notifications!.notif.target).toBe('new-channel');
  });
  it('discarding an early draft lets the pending read populate the actual saved value', async () => {
    const pending = deferred<Response>();
    let first = true;
    serve((url, init) => {
      if (url === '/api/notification-preferences' && !init?.method && first) {
        first = false;
        return pending.promise;
      }
    });
    const view = await mount();
    await notificationTarget('Typed early');
    await view.click('settings.discard');
    await act(async () => pending.resolve(json(preferences())));
    expect(captured.notifications!.notif.target).toBe('old-channel');
    expect(posts()).toHaveLength(0);
  });
});
