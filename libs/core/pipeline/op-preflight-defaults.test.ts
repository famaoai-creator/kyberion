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
      'core:effect',
      'core:introduction',
      'core:taint',
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

  it('never reports preflight-internal stamps as a repair of the caller input', async () => {
    ensureDefaultOpPreflight();
    const params = { path: 'a.txt' };
    const result = await runOpPreflight({ op: 'file:pipeline', params, source: 'actuator' });
    expect(result.input).toEqual(params);
    expect(result.repaired_input).toBeUndefined();
    expect(Object.keys(result.input).some((key) => key.startsWith('_'))).toBe(false);
  });

  it('stamps the declared manifest effect for downstream stages without leaking it into the op input', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'file:pipeline',
      params: {},
      source: 'actuator',
    });
    expect(result.decision).toBe('allow');
    expect(result.listener_ids).toContain('core:effect');
    expect((result as { stamps?: { _effect?: string } }).stamps?._effect).toBe('write');
    expect((result as { input?: { _effect?: string } }).input?._effect).toBeUndefined();
  });

  it('refines egress declarations to read for read verbs via effect_from', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'service:api',
      params: { method: 'GET' },
      source: 'actuator',
    });
    expect(result.decision).toBe('allow');
    expect((result as { stamps?: { _effect?: string } }).stamps?._effect).toBe('read');
    expect((result as { input?: { _effect?: string } }).input?._effect).toBeUndefined();
  });

  it('keeps the fail-safe write class for unknown ops', async () => {
    ensureDefaultOpPreflight();
    const result = await runOpPreflight({
      op: 'custom:undeclared',
      params: {},
      source: 'actuator',
    });
    expect(result.decision).toBe('allow');
    expect((result as { stamps?: { _effect?: string } }).stamps?._effect).toBe('write');
    expect((result as { input?: { _effect?: string } }).input?._effect).toBeUndefined();
  });
});
