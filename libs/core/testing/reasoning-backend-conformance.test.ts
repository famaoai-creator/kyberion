import { describe, expect, it } from 'vitest';
import { stubReasoningBackend } from '../reasoning-backend.js';
import { runReasoningBackendConformance } from './reasoning-backend-conformance.js';

describe('reasoning backend conformance', () => {
  it('verifies the offline stub contract without external calls', async () => {
    const report = await runReasoningBackendConformance(stubReasoningBackend);
    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.name === 'prompt')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'structured_output')?.status).toBe(
      'verified'
    );
    expect(report.checks.find((check) => check.name === 'failover')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'egress_scope')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'usage')?.status).toBe('unavailable');
    expect(report.checks.find((check) => check.name === 'sandbox_enforcement')?.status).toBe(
      'declared'
    );
  });

  it('does not call non-stub providers unless live is explicitly enabled', async () => {
    const backend = { ...stubReasoningBackend, name: 'fake-provider' };
    const report = await runReasoningBackendConformance(backend);
    expect(report.passed).toBe(false);
    expect(report.checks.every((check) => check.status !== 'failed')).toBe(true);
    expect(report.checks.find((check) => check.name === 'prompt')?.status).toBe('unavailable');
  });

  it('requires executable failover, egress, and provider usage evidence for live providers', async () => {
    const backend = { ...stubReasoningBackend, name: 'live-provider' };
    const report = await runReasoningBackendConformance(backend, {
      live: true,
      probes: {
        usage: () => ({ input_tokens: 2, output_tokens: 3, total_tokens: 5, source: 'provider' }),
        sandbox_enforcement: () => ({
          write_attempt_blocked: true,
          sentinel_created: false,
          evidence: 'provider blocked the sentinel write at runtime',
        }),
      },
    });

    expect(report.checks.find((check) => check.name === 'failover')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'egress_scope')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'usage')?.status).toBe('verified');
    expect(report.checks.find((check) => check.name === 'sandbox_enforcement')?.status).toBe(
      'verified'
    );
    expect(report.passed).toBe(true);
  });

  it('fails live conformance when a sandbox probe is omitted', async () => {
    const backend = { ...stubReasoningBackend, name: 'live-provider-without-sandbox-probe' };
    const report = await runReasoningBackendConformance(backend, {
      live: true,
      probes: {
        usage: () => ({ input_tokens: 1, output_tokens: 1, total_tokens: 2, source: 'estimated' }),
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'sandbox_enforcement')).toMatchObject({
      status: 'unavailable',
    });
  });

  it('rejects a sandbox probe that reports a created sentinel', async () => {
    const backend = { ...stubReasoningBackend, name: 'sandbox-violating-provider' };
    const report = await runReasoningBackendConformance(backend, {
      live: true,
      probes: {
        usage: () => ({ input_tokens: 1, output_tokens: 1, total_tokens: 2, source: 'estimated' }),
        sandbox_enforcement: () => ({
          write_attempt_blocked: false,
          sentinel_created: true,
          evidence: 'sentinel was created',
        }),
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'sandbox_enforcement')).toMatchObject({
      status: 'failed',
      evidence: 'sentinel was created',
    });
  });

  it('rejects contradictory not-applicable sandbox evidence', async () => {
    const backend = { ...stubReasoningBackend, name: 'contradictory-sandbox-provider' };
    const report = await runReasoningBackendConformance(backend, {
      live: true,
      probes: {
        sandbox_enforcement: () => ({
          not_applicable: true,
          write_attempt_blocked: false,
          sentinel_created: true,
          evidence: 'provider claimed both non-applicable and a write result',
        }),
      },
    });

    expect(report.checks.find((check) => check.name === 'sandbox_enforcement')).toMatchObject({
      status: 'failed',
    });
  });

  it('fails live conformance when a backend ignores an already-aborted signal', async () => {
    const backend = {
      name: 'abort-ignoring-provider',
      prompt: async (_prompt: string, _options?: { signal?: AbortSignal }) =>
        'completed despite abort',
      extractRequirements: async () => ({ functional_requirements: [] }),
    };

    const report = await runReasoningBackendConformance(backend, { live: true });

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'abort')).toMatchObject({
      status: 'failed',
      evidence: expect.stringContaining('cancellation was ignored'),
    });
  });
});
