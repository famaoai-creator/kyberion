import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeReadFile } from '@agent/core';
import { buildApplySummary, buildState, buildSummary, validateInput } from './onboarding_apply.js';

const ROOT = pathResolver.rootDir();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

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

const FIXTURE_REASONING = {
  mode: 'real_backend_detected' as const,
  backend_hint: 'codex-cli',
  available: true,
  checked_at: '2026-05-08T00:00:00.000Z',
};

describe('onboarding_apply', () => {
  it('rejects invalid tenant slugs', () => {
    expect(() =>
      validateInput({
        ...FIXTURE_INPUT,
        tenants: [{ ...FIXTURE_INPUT.tenants[0], tenant_slug: 'INVALID_SLUG' }],
      })
    ).toThrow('Invalid tenant_slug');
  });

  it('builds a summary and state from the onboarding input', () => {
    const now = '2026-05-08T00:00:00.000Z';
    const tenantEntries = [
      {
        tenant_slug: 'alpha-team',
        tenant_id: 'alpha-team',
        display_name: 'Alpha Team',
        status: 'active',
        assigned_role: 'owner',
        purpose: 'test onboarding',
        created_at: now,
      },
    ];

    const summary = buildSummary(
      FIXTURE_INPUT,
      tenantEntries,
      FIXTURE_INPUT.tutorial,
      FIXTURE_REASONING
    );
    const state = buildState(
      FIXTURE_INPUT,
      now,
      tenantEntries,
      {
        ...FIXTURE_INPUT.tutorial,
        plan_path: 'customer/acme/onboarding/tutorial-plan.md',
      },
      FIXTURE_REASONING
    );

    expect(summary).toContain('## Identity');
    expect(summary).toContain('## Reasoning Backend');
    expect(summary).toContain('- Status: real_backend_detected');
    expect(summary).toContain('Alpha Team');
    expect(state.status).toBe('complete');
    expect(state.completed_phases).toContain('reasoning');
    expect(state.reasoning.mode).toBe('real_backend_detected');
    expect(state.tenants.entries).toHaveLength(1);
    expect(state.identity.agent_id).toBe('agent-001');
  });

  it('builds a human-friendly apply summary', () => {
    const summary = buildApplySummary(
      FIXTURE_INPUT,
      [
        {
          tenant_slug: 'alpha-team',
          tenant_id: 'alpha-team',
          display_name: 'Alpha Team',
          status: 'active',
          assigned_role: 'owner',
          purpose: 'test onboarding',
          created_at: '2026-05-08T00:00:00.000Z',
        },
      ],
      FIXTURE_INPUT.tutorial,
      FIXTURE_REASONING,
      {
        statePath: 'customer/acme/onboarding/onboarding-state.json',
        summaryPath: 'customer/acme/onboarding/onboarding-summary.md',
      }
    );

    expect(summary).toContain('Onboarding applied successfully.');
    expect(summary).toContain('Identity: Famao (agent-001)');
    expect(summary).toContain('Reasoning: real_backend_detected');
    expect(summary).toContain('Next steps:');
  });

  it('uses the active customer root for onboarding artifacts', () => {
    const script = read('scripts/onboarding_apply.ts');
    expect(script).toContain('resolveActiveProfileRoot');
    expect(script).toContain('function profileRoot()');
    expect(script).toContain("path.join(profileDir, 'my-identity.json')");
    expect(script).toContain("path.join(profileRoot(), 'tenants')");
    expect(script).toContain("path.join(onboardingRoot(), 'tutorial-plan.md')");
    expect(script).toContain('statePath()');
    expect(script).toContain('summaryPath()');
  });
});
