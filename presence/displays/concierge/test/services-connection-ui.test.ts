import { afterAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  fireEvent,
  installFakeDom,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { ServicesSection } from '../src/app/settings/sections/ServicesSection';
import { conciergeText } from '../src/lib/i18n';
import type { Setup } from '../src/lib/settings-types';
vi.mock('../src/app/settings/sections/OperatorServiceRegistrationPanel', () => ({
  OperatorServiceRegistrationPanel: () => null,
}));
vi.mock('../src/app/settings/sections/OnboardingAuthorityPanel', () => ({
  OnboardingAuthorityPanel: () => null,
}));
const dom = installFakeDom();
afterAll(() => dom.restore());
const setup: Setup = {
  surface_roles: [],
  active_surfaces: [],
  reasoning_mode: 'stub',
  model_tiers: {},
  profile: {
    name: 'Synthetic fixture',
    language: 'en',
    interaction_style: '',
    primary_domain: '',
    vision: '',
    agent_id: 'fixture',
    tenant_slug: '',
    onboarding_complete: true,
    avatar_registered: false,
    voice_profiles: [],
  },
  service_catalog: [
    { id: 'github', label: 'GitHub', auth: 'oauth', configured: false },
    { id: 'browser', label: 'Browser', auth: 'session', configured: false },
  ],
  diagnostics: [],
  capabilities: [],
  tenant: { active_slug: '', runtime_bound: false, catalog: [] },
  agent_management: { configured: null, durable_identities: [] },
};
describe('service authentication controls', () => {
  it('connects the requested OAuth account without routing browser sessions to OAuth and announces failures', async () => {
    const client = await import('react-dom/client');
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = client.createRoot(container as unknown as Element);
    const connect = vi.fn();
    await act(async () =>
      root.render(
        createElement(ServicesSection, {
          locale: 'en',
          t: (key, params) => conciergeText(key, 'en', params),
          setup: {
            ...setup,
            connections: [
              {
                binding_id: 'personal-github',
                service_id: 'github',
                owner_kind: 'person',
                owner_ref: 'user:alice',
                group: 'mine',
                readiness: 'ready',
              },
              {
                binding_id: 'company-github',
                service_id: 'github',
                owner_kind: 'organization',
                owner_ref: 'alpha',
                group: 'organization',
                readiness: 'needs_credential',
              },
            ],
          },
          services: [],
          setServices: vi.fn(),
          busy: false,
          oauthBusyId: null,
          oauthMessage: 'Authorization unavailable',
          oauthError: true,
          onConnectOAuth: connect,
          onSaveConnections: vi.fn(),
          sectionRef: vi.fn(),
        })
      )
    );
    const buttons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('Connect')
    );
    expect(buttons).toHaveLength(1);
    await act(async () => {
      fireEvent(buttons[0], 'click');
    });
    expect(connect).toHaveBeenCalledWith('github', 'GitHub');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Authorization unavailable'
    );
    expect(container.textContent).toContain('Your connections');
    expect(container.textContent).toContain('Organization: alpha');
    expect(container.textContent).toContain('Credential not set');
    expect(container.textContent).toContain('does not authorize execution');
    expect(container.textContent).toContain("requires its owner's approval");
    await act(async () => root.unmount());
  });
});
