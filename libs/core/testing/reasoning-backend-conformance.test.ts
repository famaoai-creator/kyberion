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
  });

  it('does not call non-stub providers unless live is explicitly enabled', async () => {
    const backend = { ...stubReasoningBackend, name: 'fake-provider' };
    const report = await runReasoningBackendConformance(backend);
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.status !== 'failed')).toBe(true);
    expect(report.checks.find((check) => check.name === 'prompt')?.status).toBe('unavailable');
  });
});
