import { describe, expect, it } from 'vitest';
import { buildState, buildSummary, validateInput } from './onboarding_apply.js';

const FIXTURE_INPUT = {
  identity: {
    name: 'Famao',
    language: 'ja',
    interaction_style: 'Senior Partner' as const,
    primary_domain: 'productization',
    vision: 'Make the ecosystem legible and reliable.',
    agent_id: 'agent-001',
  },
  tenants: [
    {
      tenant_slug: 'alpha-team',
      display_name: 'Alpha Team',
      assigned_role: 'owner',
      purpose: 'test onboarding',
    },
  ],
  tutorial: {
    mode: 'simulate' as const,
    summary: 'Dry run first.',
  },
};

describe('onboarding_apply', () => {
  it('rejects invalid tenant slugs', () => {
    expect(() =>
      validateInput({
        ...FIXTURE_INPUT,
        tenants: [{ ...FIXTURE_INPUT.tenants[0], tenant_slug: 'INVALID_SLUG' }],
      }),
    ).toThrow('Invalid tenant_slug');
  });

  it('builds a summary and state from the onboarding input', () => {
    const now = '2026-05-08T00:00:00.000Z';
    const tenantEntries = [{
      tenant_slug: 'alpha-team',
      tenant_id: 'alpha-team',
      display_name: 'Alpha Team',
      status: 'active',
      assigned_role: 'owner',
      purpose: 'test onboarding',
      created_at: now,
    }];

    const summary = buildSummary(FIXTURE_INPUT, tenantEntries, FIXTURE_INPUT.tutorial);
    const state = buildState(FIXTURE_INPUT, now, tenantEntries, {
      ...FIXTURE_INPUT.tutorial,
      plan_path: 'knowledge/personal/onboarding/tutorial-plan.md',
    });

    expect(summary).toContain('## Identity');
    expect(summary).toContain('Alpha Team');
    expect(state.status).toBe('complete');
    expect(state.tenants.entries).toHaveLength(1);
    expect(state.identity.agent_id).toBe('agent-001');
  });
});
