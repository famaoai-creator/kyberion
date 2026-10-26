import { afterAll, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { installFakeDom } from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { GovernanceSection } from '../src/app/settings/sections/GovernanceSection';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/front-desk-fetch', () => ({ frontDeskFetch: request }));
const dom = installFakeDom();
afterAll(() => dom.restore());

it('reports an initial governance transport failure without an unhandled rejection', async () => {
  request.mockRejectedValue(new Error('Governance connection unavailable'));
  const client = await import('react-dom/client');
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(createElement(GovernanceSection, { t: (key) => key })));
    expect(request).toHaveBeenCalledWith('/api/governance-overview', { cache: 'no-store' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Governance connection unavailable'
    );
  } finally {
    await act(async () => root.unmount());
  }
});
