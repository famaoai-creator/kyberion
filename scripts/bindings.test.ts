import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { loadCoreSeamBindings } from './bindings.js';

describe('DH-03 seam bindings dump', () => {
  it('lists deterministic seam keys and multiplicities', () => {
    const bindings = loadCoreSeamBindings();
    expect(bindings.length).toBeGreaterThanOrEqual(13);
    expect(bindings.map((binding) => binding.key)).toEqual(
      [...bindings].map((binding) => binding.key).sort()
    );
    expect(bindings.find((binding) => binding.key === 'voice-bridge')?.multiplicity).toBe('sole');
    expect(bindings.find((binding) => binding.key === 'speech-to-text-bridge')?.multiplicity).toBe(
      'named'
    );
    const providers = bindings.flatMap((binding) => binding.providers);
    expect(
      providers.some((provider) => /^(provenance|source):/u.test(provider.metadata.reason))
    ).toBe(true);
  });

  it('reports reasoning selection provenance without probing or exposing values', () => {
    const selection = loadCoreSeamBindings().find(
      (binding) => binding.key === 'reasoning-backend'
    )?.reasoning_selection;
    expect(selection?.mode).toBeTypeOf('string');
    expect(selection?.reason).toBeTypeOf('string');
    expect(['memory', 'disk', 'unavailable']).toContain(selection?.provider_probe);
    expect(selection?.reason).not.toMatch(/secret|token|key=[^A-Z]/iu);
  });

  it('routes the dump output through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/bindings.ts'), { encoding: 'utf8' }) || ''
    );

    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain(
      'context.print(json ? JSON.stringify(bindings, null, 2) : renderHuman(bindings))'
    );
  });
});
