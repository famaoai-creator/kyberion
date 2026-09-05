import { describe, expect, it } from 'vitest';
import { parseSetupResponse } from './setup-response';

const validSetup = {
  ok: true,
  setup: {
    surface_roles: [
      { id: 'concierge', role_ja: '案内', tagline_ja: '案内役', port: 3000, enabled: true },
    ],
    active_surfaces: [{ id: 'concierge', port: 3000, enabled: true }],
    reasoning_mode: 'claude-cli',
    model_tiers: { fast: 'haiku' },
    profile: {
      name: 'Operator',
      language: 'ja',
      interaction_style: 'Concierge',
      primary_domain: 'operations',
      vision: 'Keep work moving',
      agent_id: 'sovereign-agent',
      tenant_slug: 'default',
      onboarding_complete: true,
      avatar_registered: false,
      voice_profiles: [],
    },
    service_catalog: [{ id: 'browser', label: 'Browser', auth: 'session', configured: true }],
    diagnostics: [{ id: 'profile', status: 'ok' }],
    capabilities: [{ id: 'approvals', label: 'Approvals', status: 'ready' }],
    tenant: {
      active_slug: 'default',
      runtime_bound: true,
      catalog: [
        {
          tenant_slug: 'default',
          tenant_id: 'tenant-1',
          display_name: 'Default',
          status: 'active',
          assigned_role: 'owner',
        },
      ],
    },
    agent_management: { configured: null, durable_identities: [] },
  },
};

describe('concierge setup response boundary', () => {
  it('accepts the setup projection consumed by the onboarding page', () => {
    expect(parseSetupResponse(validSetup)).toEqual(validSetup.setup);
  });

  it('accepts optional provider and nested setup metadata', () => {
    expect(
      parseSetupResponse({
        ...validSetup,
        setup: {
          ...validSetup.setup,
          providers: { priority: ['claude-cli'], default_models: { standard: 'sonnet' } },
          profile: {
            ...validSetup.setup.profile,
            avatar_source: 'upload',
            voice_profiles: [
              { profile_id: 'voice-1', display_name: 'Voice', sample_count: 1, sample_refs: [] },
            ],
          },
          diagnostics: [
            {
              id: 'profile',
              status: 'incomplete',
              action: { type: 'navigate', target: '#setup-profile' },
            },
          ],
          agent_management: {
            configured: { agent_id: 'agent-1', provider: 'claude-cli' },
            durable_identities: [
              {
                nhi_id: 'nhi-1',
                kind: 'agent',
                display_name: 'Agent',
                lifecycle_status: 'active',
                organization_id: 'org-1',
                provider_hint: 'claude-cli',
                model_hint: 'sonnet',
              },
            ],
          },
        },
      })
    ).toBeDefined();
  });

  it('rejects malformed root, nested values, and dangerous keys', () => {
    expect(
      parseSetupResponse({ ok: true, setup: { ...validSetup.setup, model_tiers: [] } })
    ).toBeUndefined();
    expect(
      parseSetupResponse({
        ...validSetup,
        setup: { ...validSetup.setup, diagnostics: [{ id: 'x', status: 'unknown' }] },
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"ok":true,"setup":{"surface_roles":[],"active_surfaces":[],"reasoning_mode":"x","model_tiers":{},"profile":{"name":"x","language":"ja","interaction_style":"x","primary_domain":"x","vision":"x","agent_id":"x","tenant_slug":"default","onboarding_complete":true,"avatar_registered":false,"voice_profiles":[]},"service_catalog":[],"diagnostics":[],"capabilities":[],"tenant":{"active_slug":"default","runtime_bound":false,"catalog":[]},"agent_management":{"configured":null,"durable_identities":[]},"constructor":{}}}'
    );
    expect(parseSetupResponse(unsafe)).toBeUndefined();
  });
});
