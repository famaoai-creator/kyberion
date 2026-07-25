import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

// XP-03: tier x egress gate on the delegation face. See
// docs/developer/improvement-plans-2026-07/
// CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md §XP-03 and
// libs/core/provider-egress-gate.ts.
describe('Provider egress policy contract (XP-03)', () => {
  it('validates the default provider-egress-policy.json against its schema', () => {
    const schema = JSON.parse(
      safeReadFile(
        path.join(rootDir, 'knowledge/product/schemas/provider-egress-policy.schema.json'),
        { encoding: 'utf8' }
      ) as string
    );
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/governance/provider-egress-policy.json'), {
        encoding: 'utf8',
      }) as string
    );
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const valid = validate(policy);
    expect(valid, ajv.errorsText(validate.errors)).toBe(true);
  });

  it('declares every one of the five CLI providers this plan is scoped to', () => {
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/governance/provider-egress-policy.json'), {
        encoding: 'utf8',
      }) as string
    ) as {
      providers: Record<string, { egress: string }>;
      tier_policy: {
        confidential: { approved_providers: string[] };
        personal: { approved_providers: string[] };
      };
    };

    for (const providerId of ['claude', 'codex', 'agy', 'gemini', 'copilot']) {
      expect(policy.providers).toHaveProperty(providerId);
      expect(['external-api', 'local-only']).toContain(policy.providers[providerId].egress);
    }
  });

  it('does not approve confidential/personal for a provider this policy never declares', () => {
    const policy = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/product/governance/provider-egress-policy.json'), {
        encoding: 'utf8',
      }) as string
    ) as {
      providers: Record<string, { egress: string }>;
      tier_policy: {
        confidential: { approved_providers: string[] };
        personal: { approved_providers: string[] };
      };
    };

    for (const providerId of policy.tier_policy.confidential.approved_providers) {
      expect(policy.providers).toHaveProperty(providerId);
    }
    for (const providerId of policy.tier_policy.personal.approved_providers) {
      expect(policy.providers).toHaveProperty(providerId);
    }
  });
});
