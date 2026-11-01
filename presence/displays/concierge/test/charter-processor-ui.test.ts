import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { KbI18nProvider } from '@agent/shared-ui';
import { getUiMessageBundle } from '@agent/core';
import {
  FakeElement,
  fireEvent,
  installFakeDom,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { CharterPane } from '../src/app/settings/sections/CharterPane';
import { frontDeskFetch } from '../src/lib/front-desk-fetch';
import { conciergeText } from '../src/lib/i18n';

vi.mock('../src/lib/front-desk-fetch', () => ({ frontDeskFetch: vi.fn() }));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en' }),
}));

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
const previousOptions = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'options');
beforeAll(async () => {
  dom = installFakeDom();
  Object.defineProperty(FakeElement.prototype, 'options', {
    configurable: true,
    get(this: FakeElement) {
      return this.localName === 'select' ? this.querySelectorAll('option') : undefined;
    },
  });
  client = await import('react-dom/client');
});
afterAll(() => {
  dom.restore();
  if (previousOptions) Object.defineProperty(FakeElement.prototype, 'options', previousOptions);
  else Reflect.deleteProperty(FakeElement.prototype, 'options');
});
afterEach(() => vi.clearAllMocks());

const prop = (element: FakeElement, key: string) =>
  (element as unknown as Record<string, unknown>)[key];

describe('charter processor validation in the form', () => {
  it.each([true, false])(
    'blocks invalid input before %s owner/proposal submission',
    async (canCreate) => {
      const requests: Record<string, unknown>[] = [];
      vi.mocked(frontDeskFetch).mockImplementation(async (_input, init) => {
        if (init?.method === 'POST') {
          requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response(
            JSON.stringify({
              ok: true,
              statement: 'Accepted limits',
              statement_sha256: 'a'.repeat(64),
            })
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            tenants: [
              {
                tenant_slug: 'acme',
                role: canCreate ? 'owner' : 'approver',
                can_create: canCreate,
                can_propose: !canCreate,
                can_stop: false,
                charter: null,
              },
            ],
          })
        );
      });
      const container = dom.document.createElement('div');
      dom.document.body.appendChild(container);
      const root = client.createRoot(container as unknown as Element);
      const ui = getUiMessageBundle('en');
      const t = (
        key: Parameters<typeof conciergeText>[0],
        params?: Record<string, string | number>
      ) => conciergeText(key, 'en', params);
      await act(async () => {
        root.render(
          createElement(
            KbI18nProvider,
            { locale: ui.locale, messages: ui.messages },
            createElement(CharterPane, { t })
          )
        );
      });
      const query = (selector: string) => {
        const el = container.querySelector(selector);
        if (!el) throw new Error('Missing ' + selector);
        return el;
      };
      const input = (id: string, value: string) =>
        act(() => {
          const field = query('[id="kbf-' + id + '"]');
          (field as unknown as Record<string, unknown>).value = value;
          fireEvent(field, 'input');
        });
      try {
        const label = t(canCreate ? 'setup.charter_review' : 'setup.charter_propose');
        const button = [...container.querySelectorAll('button')].find(
          (el) => el.textContent === label
        );
        expect(button).toBeDefined();
        input('charter-approved-processors', 'INVALID!');
        expect(serializeFake(container)).toContain(t('setup.charter_processors_invalid'));
        expect(prop(button!, 'disabled')).toBe(true);
        await act(async () => fireEvent(button!, 'click'));
        expect(requests).toEqual([]);
        input('charter-approved-processors', 'claude');
        expect(prop(button!, 'disabled')).toBe(true);
        input('charter-processing-purposes', 'customer_service');
        input('charter-processing-categories', 'routine_business');
        expect(prop(button!, 'disabled')).toBe(false);
        expect(serializeFake(container)).not.toContain(t('setup.charter_processors_invalid'));
        await act(async () => fireEvent(button!, 'click'));
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          action: canCreate ? 'preview' : 'propose',
          form: {
            approved_processors: ['claude'],
            processing_purposes: ['customer_service'],
            processing_categories: ['routine_business'],
          },
        });
      } finally {
        act(() => root.unmount());
        dom.document.body.removeChild(container);
      }
    }
  );
});
