import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  FakeElement,
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { AccountIntroductionPanel } from '../src/app/settings/sections/AccountIntroductionPanel';
import type { SettingsTranslate } from '../src/app/settings/sections/form-scope';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/front-desk-fetch', () => ({ frontDeskFetch: fetchMock }));
const t: SettingsTranslate = (key) => key;
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
const roots: Array<() => void> = [];
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  vi.resetAllMocks();
});
afterAll(() => dom.restore());
function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const render = (bindingId: string) =>
    act(() => root.render(createElement(AccountIntroductionPanel, { bindingId, t })));
  render('first');
  roots.push(() => root.unmount());
  return { container, render };
}
const reply = (value: unknown) => new Response(JSON.stringify({ ok: true, ...(value as object) }));
const preview = (binding_id: string) => ({
  binding_id,
  service_id: 'github',
  secret_refs: ['GITHUB_TOKEN'],
  statement: 'reviewed account',
  digest: 'hash',
  expected_generation: null,
});
async function click(container: FakeElement, label: string) {
  const button = container.querySelectorAll('button').find((node) => node.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => {
    fireEvent(button!, 'click');
  });
}
describe('account collector lifecycle', () => {
  it('does not collect values before status confirms approval', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(preview('first')))
      .mockResolvedValueOnce(reply({ approval_id: 'id', approval_url: '/?approvalId=id' }))
      .mockResolvedValueOnce(reply({ can_apply: false }))
      .mockResolvedValueOnce(reply({ can_apply: true }));
    const { container } = mount();
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_preview');
    await click(container, 'settings.secret_propose');
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_refresh');
    expect(container.querySelector('input')).toBeNull();
    await click(container, 'settings.account_refresh');
    expect(container.querySelector('input')).not.toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !String(init.body).includes('material'))).toBe(
      true
    );
  });
  it('ignores an old response and aborts its transport when the binding changes', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const { container, render } = mount();
    await click(container, 'settings.account_preview');
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    render('second');
    expect(signal.aborted).toBe(true);
    await act(async () => {
      release(reply(preview('first')));
    });
    expect(container.textContent).not.toContain('reviewed account');
    expect(container.querySelector('input')).toBeNull();
  });
  it('clears the collector on an uncertain apply and never retries the submitted material', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(preview('first')))
      .mockResolvedValueOnce(reply({ approval_id: 'id', approval_url: '/?approvalId=id' }))
      .mockResolvedValueOnce(reply({ can_apply: true }))
      .mockRejectedValueOnce(new Error('transport failed'));
    const { container } = mount();
    await click(container, 'settings.account_preview');
    await click(container, 'settings.secret_propose');
    await click(container, 'settings.account_refresh');
    const input = container.querySelector('input')!;
    await act(async () => {
      (input as unknown as { value: string }).value = 'synthetic-token';
      fireEvent(input, 'input');
    });
    await act(async () => {
      fireEvent(container.querySelector('form')!, 'submit');
    });
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('settings.account_recovery');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toEqual({
      action: 'apply',
      binding_id: 'first',
      approval_id: 'id',
      material: { GITHUB_TOKEN: 'synthetic-token' },
    });
    await click(container, 'settings.account_close');
    expect(container.querySelector('input')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('blocks duplicate clicks before React has painted the busy state', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = mount();
    const button = container.querySelector('button')!;
    await act(async () => {
      fireEvent(button, 'click');
      fireEvent(button, 'click');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const gwsPreview = () => ({
  ...preview('first'),
  service_id: 'google-workspace',
  owner_kind: 'organization',
  secret_refs: [],
  material_kind: 'gws-authorized-user-v1',
  runtimeAvailable: false,
});
describe('GWS account collector', () => {
  async function approved() {
    fetchMock
      .mockResolvedValueOnce(reply(gwsPreview()))
      .mockResolvedValueOnce(reply({ approval_id: 'gws-id', approval_url: '/?approvalId=gws-id' }))
      .mockResolvedValueOnce(reply({ can_apply: true }));
    const view = mount();
    await click(view.container, 'settings.account_preview');
    await click(view.container, 'settings.secret_propose');
    expect(view.container.querySelector('input')).toBeNull();
    await click(view.container, 'settings.account_refresh');
    return view;
  }
  async function fill(container: FakeElement) {
    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(3);
    await act(async () => {
      inputs.forEach((input, i) => {
        (input as unknown as { value: string }).value = `synthetic-${i}`;
        fireEvent(input, 'input');
      });
    });
  }
  it('collects exact authorized_user fields after approval and reports registration-only success', async () => {
    const { container } = await approved();
    await fill(container);
    fetchMock.mockResolvedValueOnce(
      reply({
        status: 'applied',
        generation: 'new',
        material_kind: 'gws-authorized-user-v1',
        runtimeAvailable: false,
      })
    );
    await act(async () => {
      fireEvent(container.querySelector('form')!, 'submit');
    });
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toEqual({
      action: 'apply',
      binding_id: 'first',
      approval_id: 'gws-id',
      material: {
        type: 'authorized_user',
        client_id: 'synthetic-0',
        client_secret: 'synthetic-1',
        refresh_token: 'synthetic-2',
      },
    });
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('settings.account_gws_registered');
    expect(container.textContent).not.toContain('synthetic');
  });
  it.each(['close', 'reselect'])(
    'clears all GWS fields on %s without submitting',
    async (action) => {
      const { container, render } = await approved();
      await fill(container);
      if (action === 'close') await click(container, 'settings.account_close');
      else render('second');
      expect(container.querySelector('input')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  );
  it('ignores stale GWS approval responses after reselection', async () => {
    const { container, render } = await approved();
    await fill(container);
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    await click(container, 'settings.account_refresh');
    const signal = fetchMock.mock.calls[3]![1].signal as AbortSignal;
    render('second');
    await act(async () => {
      release(reply({ can_apply: true }));
    });
    expect(signal.aborted).toBe(true);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('synthetic');
  });
  it('rejects personal GWS previews', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...gwsPreview(), owner_kind: 'person' }));
    const { container } = mount();
    await click(container, 'settings.account_preview');
    expect(container.textContent).toContain('settings.operator_unavailable');
    expect(container.querySelector('input')).toBeNull();
  });
});
