import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  FakeElement,
  fireEvent,
  installFakeDom,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { OnboardingAuthorityPanel } from '../src/app/settings/sections/OnboardingAuthorityPanel';
const passkeyDecision = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/lib/passkey-client', () => ({ decideWithPasskey: passkeyDecision }));

vi.mock('../src/lib/front-desk-fetch', () => ({
  frontDeskFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
const originalOptions = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'options');
beforeAll(async () => {
  dom = installFakeDom();
  Object.defineProperty(FakeElement.prototype, 'options', {
    configurable: true,
    get(this: FakeElement) {
      return this.localName === 'select'
        ? this.children.filter((child) => child.localName === 'option')
        : undefined;
    },
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  passkeyDecision.mockReset();
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (originalOptions) Object.defineProperty(FakeElement.prototype, 'options', originalOptions);
  else Reflect.deleteProperty(FakeElement.prototype, 'options');
  dom.restore();
});
const receipt = (pending_requests: unknown[] = []) => ({
  ok: true,
  scope: { kind: 'person' },
  accountable: { id: 'human:fixture', display_name: 'Fixture owner' },
  charter: null,
  delegable_decisions: [],
  pending_requests,
  runtime: { ready: true, agent_id: 'kyberion://agent/fixture/installed' },
  renewal_required: false,
  renewal: null,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function mount(respond: (body?: Record<string, unknown>, url?: string) => Promise<Response>) {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body) posts.push(body);
      return respond(body, url);
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      createElement(OnboardingAuthorityPanel, {
        locale: 'en',
        tenants: [{ tenant_slug: 'acme', display_name: 'Acme' }],
        selectedTenant: 'acme',
      })
    )
  );
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === text
    );
    expect(button).toBeDefined();
    await act(async () => {
      fireEvent(button!, 'click');
    });
  };
  const change = async (selector: string, value: string, index = 0) => {
    const node = container.querySelectorAll(selector)[index];
    expect(node).toBeDefined();
    await act(async () => {
      Object.assign(node, { value });
      fireEvent(node, node.localName === 'select' ? 'change' : 'input');
    });
  };
  const check = async (text: string, checked: boolean, index = 0) => {
    const label = [...container.querySelectorAll('label')].filter(
      (item) => item.textContent === text
    )[index];
    expect(label).toBeDefined();
    const input = label.querySelector('input')!;
    await act(async () => {
      Object.assign(input, { checked });
      fireEvent(input, 'click');
    });
  };
  return { container, posts, click, change, check };
}
describe('onboarding authority review and resumption', () => {
  it('reviews one private development bundle and personal tiers without granting base pushes', async () => {
    const m = await mount(async (body) =>
      !body
        ? json(receipt())
        : json({
            ok: true,
            statement: 'Reviewed development bundle',
            digest: 'digest',
            base_hash: 'base',
          })
    );
    await m.change('select', 'vcs:pr_merge', 1);
    await m.change('input[type="text"]', 'release/custom');
    const genericBranch = m.container.querySelector('input[type="text"]')!;
    expect(Reflect.get(genericBranch, 'value')).toBe('release/custom');
    expect(genericBranch.hasAttribute('readOnly')).toBe(false);
    await m.change('select', 'vcs:development', 1);
    const fixedBranches = [...m.container.querySelectorAll('input[type="text"]')];
    expect(fixedBranches.map((input) => Reflect.get(input, 'value'))).toEqual([
      'agent/kyberion-development',
      'main',
    ]);
    expect(fixedBranches.every((input) => input.hasAttribute('readOnly'))).toBe(true);
    await m.change('input[type="url"]', 'https://github.com/owner/repo');
    await m.change('input[type="datetime-local"]', '2099-10-21T12:00');
    await m.check('Require a verified private repository', true);
    await m.check('Set delegated data tiers', true);
    await m.check('Personal', true);
    await m.click('Preview exact authority');
    expect(m.posts[0]).toMatchObject({
      data_tier: { read: ['public', 'personal'], write: [] },
      grants: [
        {
          operation_id: 'vcs:pr_create',
          repository: 'https://github.com/owner/repo',
          visibility: 'private',
        },
        {
          operation_id: 'vcs:push',
          repository: 'https://github.com/owner/repo',
          branch: 'agent/kyberion-development',
          visibility: 'private',
        },
        {
          operation_id: 'vcs:pr_merge',
          repository: 'https://github.com/owner/repo',
          branch: 'main',
          visibility: 'private',
        },
      ],
    });
    await m.check('Personal', false);
    expect(m.container.textContent).not.toContain('Reviewed development bundle');
    expect(m.posts).toHaveLength(1);
  });
  it('retains the exact branch and private marker when revoking an existing grant', async () => {
    const granted = {
      ...receipt(),
      charter: {
        id: 'charter',
        expires_at: '2099-10-21T12:00:00.000Z',
        stopped: false,
        delegated_decisions: {meeting_scheduling:'allow_with_review'},
        data_tier: { read: ['public', 'personal'], write: [] },
        grants: [
          {
            operation_id: 'vcs:pr_merge',
            repository: 'https://github.com/owner/repo',
            branch: 'release',
            visibility: 'private',
          },
        ],
      },
    };
    const m = await mount(async (body) =>
      !body
        ? json({...granted,delegable_decisions:[{decision_type:'meeting_scheduling',label:{en:'Meeting scheduling',ja:'会議調整'}}]})
        : json({ ok: true, statement: 'Reviewed revocation', digest: 'digest', base_hash: 'base' })
    );
    await m.change('select','allow',2);
    await m.click('Review revocation');
    await m.click('Preview exact authority');
    expect(m.posts[0]).toMatchObject({
      mode: 'revoke',
      grants: [
        {
          operation_id: 'vcs:pr_merge',
          repository: 'https://github.com/owner/repo',
          branch: 'release',
          visibility: 'private',
        },
      ],
    });
    expect(m.posts[0]).not.toHaveProperty('data_tier');
    expect(m.posts[0]).not.toHaveProperty('delegated_decisions');
  });
  it('requires explicit renewal consent for the displayed existing limits and withdraws stale preview', async () => {
    const renewal = {
      id: 'expired-existing',
      envelope: {
        external_operations: [{ operation_id: 'browser:goto', origin: 'https://existing.test' }],
      },
      appetite: { max_loss_per_incident: 0 },
    };
    const m = await mount(async (body) =>
      !body
        ? json({ ...receipt(), renewal_required: true, renewal })
        : json({
            ok: true,
            statement: 'Renew displayed existing limits',
            digest: 'renew-digest',
            base_hash: 'expired-base',
          })
    );
    expect(m.container.textContent).toContain('https://existing.test');
    const checkbox = m.container.querySelector('input[type="checkbox"]')!;
    expect(Reflect.get(checkbox, 'checked')).toBe(false);
    await m.change('select', 'vcs:pr_create', 1);
    await m.change('input[type="url"]', 'https://github.com/fixture/repo');
    await m.change('input[type="datetime-local"]', '2099-10-21T12:00');
    const preview = [...m.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Preview exact authority'
    )!;
    expect(preview.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      Object.assign(checkbox, { checked: true });
      fireEvent(checkbox, 'click');
    });
    await m.click('Preview exact authority');
    expect(m.posts[0]).toMatchObject({ renew_existing: true });
    expect(m.container.textContent).toContain('Ask this agent to request these permissions');
    await act(async () => {
      Object.assign(checkbox, { checked: false });
      fireEvent(checkbox, 'click');
    });
    expect(m.container.textContent).not.toContain('Ask this agent to request these permissions');
  });
  it('distinguishes a retained grant from an agent awaiting activation', async () => {
    const m = await mount(async () =>
      json({
        ...receipt(),
        runtime: {
          ready: false,
          agent_id: 'kyberion://agent/fixture/provisioned',
          reason: 'activation_requires_approval',
        },
        charter: {
          id: 'granted',
          stopped: false,
          expires_at: '2099-01-01T00:00:00Z',
          grants: [],
          delegated_decisions: {},
        },
      })
    );
    expect(m.container.textContent).toContain('Agent execution is not ready');
    expect(m.container.textContent).toContain('activation_requires_approval');
    expect(m.container.textContent).toContain('Current authority');
    expect(m.container.textContent).not.toContain('The registered agent is active.');
  });
  it.each(['A2', 'A3'])(
    'shows exact CLI request before an %s human decision and never auto-applies',
    async (min_assurance) => {
      const m = await mount(async (body) =>
        !body
          ? json(receipt([{ request_id: 'review-cli', status: 'pending' }]))
          : body.action === 'status'
            ? json({
                ok: true,
                status: 'pending',
                can_apply: false,
                statement: 'Only open https://example.test',
                presented_digest: 'exact-card-digest',
                approval_channel: 'onboarding-authority',
                min_assurance,
              })
            : json({ ok: true })
      );
      expect(m.container.textContent).not.toContain('Approve this reviewed authority');
      await m.click('Check request status');
      expect(m.container.textContent).toContain('Only open https://example.test');
      await m.click('Approve this reviewed authority');
      const binding = {
        decision: 'approved',
        channel: 'onboarding-authority',
        storageChannel: 'onboarding-authority',
        presentedDigest: 'exact-card-digest',
      };
      if (min_assurance === 'A2') expect(m.posts[1]).toEqual(binding);
      else {
        expect(passkeyDecision).toHaveBeenCalledWith({ requestId: 'review-cli', ...binding });
        expect(m.posts).toHaveLength(1);
      }
      expect(m.container.textContent).not.toContain('Apply approved authority');
    }
  );
  it('reviews revocation of one actual grant and requests signed approval with its exact digest', async () => {
    const current = {
      ...receipt(),
      charter: {
        id: 'existing',
        delegated_decisions: {},
        expires_at: '2099-10-21T12:00:00.000Z',
        stopped: false,
        grants: [
          { operation_id: 'browser:goto', origin: 'https://example.test' },
          { operation_id: 'browser:open_tab', origin: 'https://other.test' },
        ],
      },
    };
    const m = await mount(async (body) =>
      !body
        ? json(current)
        : body.action === 'preview'
          ? json({
              ok: true,
              statement: 'Revoke only example navigation',
              digest: 'reviewed-digest',
              base_hash: 'current-hash',
            })
          : json({
              ok: true,
              request_id: 'revocation',
              status: 'pending',
              approval_url: '/?request=revocation',
            })
    );
    await m.click('Review revocation');
    await m.click('Preview exact authority');
    await m.click('Ask this agent to request these permissions');
    expect(m.posts).toHaveLength(2);
    expect(m.posts[1]).toMatchObject({
      action: 'request',
      mode: 'revoke',
      grants: [{ operation_id: 'browser:goto', origin: 'https://example.test' }],
      digest: 'reviewed-digest',
      base_hash: 'current-hash',
      scope_kind: 'person',
    });
    expect(JSON.stringify(m.posts[1])).not.toContain('other.test');
    expect(m.container.textContent).toContain('revocation');
    expect(m.container.textContent).not.toContain('Apply approved authority');
  });
  it('discovers CLI-created pending requests on fresh load and applies only after confirmed human approval', async () => {
    const m = await mount(async (body) =>
      !body
        ? json(
            receipt([
              {
                request_id: 'pending-cli',
                status: 'pending',
                approval_url: '/?request=pending-cli',
              },
            ])
          )
        : body.action === 'status'
          ? json({ ok: true, status: 'approved', can_apply: true })
          : json({ ok: true, charter_id: 'charter' })
    );
    expect(m.container.textContent).toContain('pending-cli');
    expect(m.container.textContent).not.toContain('Apply approved authority');
    expect(m.container.querySelector('a')?.getAttribute('href')).toBe('/?request=pending-cli');
    await m.click('Check request status');
    await m.click('Apply approved authority');
    expect(m.posts).toEqual([
      { action: 'status', scope_kind: 'person', request_id: 'pending-cli' },
      { action: 'apply', scope_kind: 'person', request_id: 'pending-cli' },
    ]);
    expect(JSON.stringify(m.posts)).not.toContain('acme');
  });
  it('starts with no grant and invalidates exact approval preview when target changes', async () => {
    const m = await mount(async (body) =>
      !body
        ? json(receipt())
        : json({
            ok: true,
            statement: 'Exact reviewed repository',
            digest: 'digest',
            base_hash: 'base',
          })
    );
    expect(Reflect.get(m.container.querySelectorAll('select')[1], 'value')).toBe('');
    await m.change('select', 'vcs:pr_create', 1);
    await m.change('input[type="url"]', 'https://github.com/owner/repo');
    await m.change('input[type="datetime-local"]', '2099-10-21T12:00');
    await m.click('Preview exact authority');
    expect(m.posts[0]).toMatchObject({
      scope_kind: 'person',
      action: 'preview',
      grants: [{ operation_id: 'vcs:pr_create', repository: 'https://github.com/owner/repo' }],
    });
    expect(m.container.textContent).toContain('Ask this agent to request these permissions');
    await m.change('input[type="url"]', 'https://github.com/owner/other');
    expect(m.container.textContent).not.toContain('Ask this agent to request these permissions');
    expect(m.posts).toHaveLength(1);
  });
  it('keeps an unconfirmed apply visible as an error instead of claiming configured authority', async () => {
    const m = await mount(async (body) =>
      !body
        ? json(receipt([{ request_id: 'approved-cli', status: 'approved', can_apply: true }]))
        : json({ ok: false, error: 'Scope changed; review again' }, 409)
    );
    await m.click('Apply approved authority');
    expect(m.container.querySelector('[role="alert"]')?.textContent).toContain('Scope changed');
    expect(m.container.textContent).toContain('No delegation is configured');
  });
});
