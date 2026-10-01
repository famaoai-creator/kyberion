import { describe, expect, it } from 'vitest';
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
