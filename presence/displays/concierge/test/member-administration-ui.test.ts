import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { MemberAdministrationPanel } from '../src/app/settings/sections/MemberAdministrationPanel';
import type { SettingsMember, SettingsTenantView } from '../src/lib/settings-types';
const members: SettingsMember[] = [
  {
    member_id: 'owner',
    display_name: 'Synthetic operator',
    status: 'active',
    sign_in: 'local',
    memberships: [{ tenant_slug: 'alpha', role: 'owner' }],
    external_identities: [],
    version: 'owner-v1',
  },
  {
    member_id: 'alice',
    display_name: 'Alice',
    status: 'active',
    sign_in: 'token',
    memberships: [{ tenant_slug: 'alpha', role: 'operator' }],
    external_identities: [],
    version: 'alice-v1',
  },
];
const tenants: SettingsTenantView[] = [
  { tenant_slug: 'alpha', display_name: 'Alpha', role: 'owner', status: 'active' },
  { tenant_slug: 'beta', display_name: 'Beta read only', role: 'viewer', status: 'active' },
];
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
});
afterAll(() => dom.restore());
async function mount() {
  const patch = vi.fn();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      createElement(MemberAdministrationPanel, {
        members,
        tenants,
        busy: false,
        locale: 'ja',
        t: (key) => key,
        onPatch: patch,
        contextId: 'context-a',
      })
    )
  );
  const changeSelect = async (index: number, value: string) => {
    await act(async () => {
      const field = container.querySelectorAll('select')[index];
      (field as unknown as { value: string }).value = value;
      fireEvent(field, 'change');
    });
  };
  const click = async (label: string) => {
    const button = container
      .querySelectorAll('button')
      .find((node) => serializeFake(node).includes(label));
    if (!button) throw new Error('Missing ' + label);
    await act(async () => {
      fireEvent(button, 'click');
    });
  };
  return { container, patch, changeSelect, click, text: () => serializeFake(container) };
}
describe('human access management UI', () => {
  it('identifies the local operator and makes the target company an explicit choice', async () => {
    const ui = await mount();
    expect(ui.text()).toContain('people.local_operator');
    await ui.changeSelect(0, 'alice');
    expect(ui.text()).toContain('people.member_access_hint');
    const selector = ui.container.querySelectorAll('select')[1];
    expect(serializeFake(selector)).toContain('Alpha');
    expect(serializeFake(selector)).not.toContain('Beta read only');
    expect((selector as unknown as { value: string }).value).toBe('');
    expect(ui.patch).not.toHaveBeenCalled();
  });
  it('reviews access removal before calling the existing shared HTTP handler', async () => {
    const ui = await mount();
    await ui.changeSelect(0, 'alice');
    await ui.changeSelect(1, 'alpha');
    await ui.click('people.remove_access');
    expect(ui.patch).not.toHaveBeenCalled();
    expect(ui.text()).toContain('management.confirm_save');
    await ui.click('management.confirm_save');
    expect(ui.patch).toHaveBeenCalledWith('alice', {
      membership_remove: 'alpha',
      expected_version: 'alice-v1',
      expected_context_id: 'context-a',
    });
  });
  it('keeps canonical operator access removal disabled', async () => {
    const ui = await mount();
    await ui.changeSelect(0, 'owner');
    await ui.changeSelect(1, 'alpha');
    const button = ui.container
      .querySelectorAll('button')
      .find((node) => serializeFake(node).includes('people.remove_access'))!;
    expect(serializeFake(button)).toContain('disabled');
    expect(ui.patch).not.toHaveBeenCalled();
  });
});
