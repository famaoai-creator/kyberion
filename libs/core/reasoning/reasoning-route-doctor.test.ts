import { describe, expect, it, vi } from 'vitest';
import { probeReasoningRouteMode } from './reasoning-route-doctor.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('reasoning route doctor boundaries', () => {
  const source = () =>
    String(
      safeReadFile(pathResolver.rootResolve('libs/core/reasoning/reasoning-route-doctor.ts'), {
        encoding: 'utf8',
      })
    );

  it('never reads provider credentials from process.env directly', () => {
    expect(source()).not.toContain('process.env.ANTHROPIC_API_KEY');
  });

  it('derives probes and remediation from the provider registry, not per-mode branches (RS-03)', () => {
    const text = source();
    expect(text).not.toMatch(/mode === '/u);
    expect(text).not.toMatch(/'(?:codex|gemini|grok|cursor|opencode|devin|agy)-cli'/u);
    expect(text).toContain('setup_hint');
    expect(text).toContain('probeReasoningProviderReadiness');
  });
});

describe('reasoning route doctor live probing (S4)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test-placeholder' } as NodeJS.ProcessEnv;

  it('checks only key presence by default — no live Anthropic request', async () => {
    const anthropicProbe = vi.fn(async () => ({ available: true }));
    const result = await probeReasoningRouteMode('anthropic', {
      env,
      readinessDeps: { anthropicProbe },
    });
    expect(anthropicProbe).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ready',
      reason: 'ANTHROPIC_API_KEY configured; live call not consumed',
    });
    await expect(probeReasoningRouteMode('anthropic', { env: {} })).resolves.toEqual({
      status: 'not_configured',
      reason: 'ANTHROPIC_API_KEY is not configured',
    });
  });

  it('runs the live probe only when explicitly requested', async () => {
    const anthropicProbe = vi.fn(async () => ({ available: false, reason: '401 unauthorized' }));
    const result = await probeReasoningRouteMode('anthropic', {
      env,
      live: true,
      readinessDeps: { anthropicProbe },
    });
    expect(anthropicProbe).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'not_configured', reason: '401 unauthorized' });
  });
});
