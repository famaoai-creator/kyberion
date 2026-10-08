import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';
import { FRONT_DESK_MENU, resolveFrontDeskMenu } from '@agent/core/front-desk-nav';

const source = String(
  safeReadFile('presence/displays/presence-studio/static/front-desk-rail.js')
).replace("import { renderA2UI } from '/shared-ui/kyberion-ui.js';", '');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface RailItem {
  id: string;
  active?: boolean;
  group_label: string;
  icon: string;
  href: string;
}
interface RailRender {
  components: Array<{ props: { items: RailItem[]; footer_items?: RailItem[] } }>;
  options: { onAction(action: { id: string; payload: { value: string } }): void };
}
function harness(pathname: string, fetchOverride?: (url: string) => Promise<unknown>) {
  const rendered: RailRender[] = [];
  const location = { pathname, reload: vi.fn() };
  let tenant = 'alpha';
  const menu = resolveFrontDeskMenu({
    currentSurface: 'presence-studio',
    role: 'owner',
    availableSurfaces: {
      'chronos-mirror-v2': 'http://localhost:3000',
      'operator-surface': 'http://localhost:3331',
    },
  }).map((item) => ({ ...item, label: item.id, sublabel: item.id, group_label: item.group_key }));
  const me = (slug = 'alpha') => ({
    ok: true,
    viewing: { tenant_slug: slug, role: 'owner', display_name: slug },
    tenants: [],
    can_switch: false,
  });
  const fetch = vi.fn(async (url: string) => {
    if (fetchOverride) {
      const override = await fetchOverride(url);
      if (override) return override;
    }
    return {
      json: async () =>
        url.includes('/api/me')
          ? me(new URL(url, 'http://localhost').searchParams.get('tenant') ?? 'alpha')
          : url.includes('/api/front-desk/nav')
            ? { ok: true, items: menu, role_labels: { owner: 'Owner' } }
            : { ok: true, messages: {} },
    };
  });
  const window = {
    location,
    localStorage: {
      getItem: () => tenant,
      setItem: (_key: string, value: string) => {
        tenant = value;
      },
    },
    KyberionPrefs: {
      locale: () => 'en',
      tenant: () => tenant,
      setTenant: (value: string) => {
        tenant = value;
      },
      scopedUrl: (href: string) => {
        const url = new URL(href, 'http://localhost');
        url.searchParams.set('tenant', tenant);
        return url.href;
      },
    },
  };
  runInNewContext(source, {
    window,
    document: { querySelector: () => null },
    fetch,
    URL,
    renderA2UI: (
      _host: unknown,
      components: RailRender['components'],
      options: RailRender['options']
    ) => {
      rendered.push({ components, options });
    },
  });
  const client = window as typeof window & {
    FrontDeskRail: { mount(host: object, options: { current: string }): Promise<unknown> };
  };
  return {
    window,
    rendered,
    menu,
    me,
    fetch,
    tenant: () => tenant,
    mount: () => client.FrontDeskRail.mount({}, { current: 'home' }),
  };
}
describe('shipped grouped front-desk rail client', () => {
  it.each([
    ['/work', 'workspace'],
    ['/first-job', 'first-job'],
    ['/help/owner', 'help'],
  ])('marks %s from the route rather than a stale home hint', async (path, id) => {
    const h = harness(path);
    await h.mount();
    const items = h.rendered.at(-1)!.components[0].props.items;
    expect(items).toHaveLength(FRONT_DESK_MENU.length);
    expect(items.filter((item) => item.active).map((item) => item.id)).toEqual([id]);
    expect(
      items.every((item) => item.group_label && item.icon && item.href.includes('tenant=alpha'))
    ).toBe(true);
    expect(items.find((item) => item.id === 'missions').href).toContain('section=missions');
  });
  it('fails closed for denied and unknown allowed values, without duplicate help', async () => {
    const h = harness('/work');
    h.menu[0].allowed = false;
    (h.menu[1] as { allowed?: boolean }).allowed = undefined;
    await h.mount();
    const items = h.rendered.at(-1)!.components[0].props.items;
    expect(items.some((item) => item.id === 'home' || item.id === 'ask')).toBe(false);
    expect(items.filter((item) => item.id === 'help')).toHaveLength(1);
    expect(h.rendered.at(-1)!.components[0].props.footer_items).toBeUndefined();
  });
  it('ignores an interrupted older mount', async () => {
    const old = deferred<unknown>();
    let count = 0;
    const h = harness('/first-job', async (url) =>
      url.includes('/api/me') && ++count === 1 ? old.promise : undefined
    );
    const first = h.mount();
    await h.mount();
    old.resolve({ json: async () => h.me('old') });
    await first;
    expect(h.tenant()).toBe('alpha');
    expect(h.rendered).toHaveLength(1);
  });
  it('only completes the latest repeated tenant switch', async () => {
    const older = deferred<unknown>();
    const h = harness('/work', async (url) =>
      url.includes('tenant=beta') ? older.promise : undefined
    );
    await h.mount();
    const action = h.rendered.at(-1)!.options.onAction;
    action({ id: 'tenant.switch', payload: { value: 'beta' } });
    action({ id: 'tenant.switch', payload: { value: 'gamma' } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    older.resolve({ json: async () => h.me('beta') });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.tenant()).toBe('gamma');
    expect(h.window.location.reload).toHaveBeenCalledTimes(1);
  });
});
