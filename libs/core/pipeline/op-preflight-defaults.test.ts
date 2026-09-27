import { afterEach, describe, expect, it } from 'vitest';
import {
  listOpGuards,
  listOpPreflightListeners,
  resetOpPreflight,
  runOpPreflight,
} from './op-preflight.js';
import { ensureDefaultOpPreflight } from './op-preflight-defaults.js';

afterEach(() => resetOpPreflight());

describe('default operation preflight waterfall', () => {
  it('installs the standard listeners and guard idempotently', () => {
    ensureDefaultOpPreflight();
    ensureDefaultOpPreflight();
    expect(listOpPreflightListeners().map((entry) => entry.id)).toEqual([
      'core:scope',
      'core:adf-guardrails',
      'core:provider-egress',
    ]);
    expect(listOpGuards().map((entry) => entry.id)).toEqual(['core:spend']);
  });

  it('fails closed for a protected operation without a tenant binding', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'service:write',
      params: { tier: 'confidential' },
      source: 'actuator',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('tenant_slug is required');
    expect(result.terminate).toBe(true);
  });

  it('keeps an explicitly scoped public operation admissible', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'service:read',
      params: { tier: 'public', tenant_slug: 'tenant-acme' },
      source: 'actuator',
    });
    expect(result.decision).toBe('allow');
  });

  it('blocks malformed ADF before dispatch', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'pipeline:execute',
      params: {
        adf: { steps: [{ op: 'core:loop_until', params: { pipeline: [] } }] },
      },
      source: 'pipeline',
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('graph-loop-without-bound');
  });
});
