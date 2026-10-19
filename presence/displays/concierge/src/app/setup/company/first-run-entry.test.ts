import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { conciergeText } from '../../../lib/i18n';

const harness = vi.hoisted(() => ({ values: [] as unknown[] }));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: () => [harness.values.shift(), vi.fn()],
  useEffect: () => {},
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock('../../../lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({
    locale: 'en',
    t: (key: Parameters<typeof conciergeText>[0]) => conciergeText(key, 'en'),
  }),
}));
vi.mock('../identity-link-section', () => ({ IdentityLinkSection: () => null }));
vi.mock('../sso-settings-form', () => ({ SsoSettingsForm: () => null }));
import FirstRunSetupPage from '../first-run/page';

function render(stored: boolean) {
  harness.values = [
    'unclaimed',
    0,
    '',
    '',
    '',
    '',
    false,
    null,
    stored,
    { token: 'FIXTURE-SECRET-TOKEN', tenant_slug: 'company-a', member_id: 'owner-a' },
  ];
  return renderToStaticMarkup(React.createElement(FirstRunSetupPage));
}
describe('first-run company setup continuation wiring', () => {
  it('links the claimed company after token storage without putting the token in a URL', () => {
    const html = render(true);
    expect(html).toContain('href="/setup/company?tenant=company-a"');
    expect(html).toContain('Set up this company');
    expect(html.match(/href="[^"]*"/g)?.join(' ')).not.toContain('FIXTURE-SECRET-TOKEN');
  });
  it('waits for successful token storage before offering the continuation', () => {
    expect(render(false)).not.toContain('href="/setup/company');
  });
});
