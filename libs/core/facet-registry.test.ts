import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { registerPluginFacet, resolveFacets, validateFacetPurity } from './facet-registry.js';

describe('facet-registry', () => {
  it('keeps legacy role procedures resolvable as product persona facets', () => {
    const facets = resolveFacets(
      { persona: 'product_manager', instructions: ['default'] },
      { tier: 'public' }
    );
    expect(facets.persona?.source).toBe('legacy');
    expect(facets.persona?.content).toMatch(/Product Orchestrator/);
    expect(facets.instructions[0]?.source).toBe('builtin');
  });

  it('fails closed when a public pipeline tries to select a tenant facet', () => {
    expect(() =>
      resolveFacets({ persona: 'product_manager' }, { tier: 'public', tenantSlug: 'tenant-a' })
    ).toThrow(/FACET_TIER_DENIED/);
  });

  it('does not turn a misspelled facet name into an unrelated default', () => {
    expect(() => resolveFacets({ policies: ['misspelled-policy'] }, { tier: 'public' })).toThrow(
      /FACET_NOT_FOUND/
    );
  });

  it('resolves only declared facets from an approved managed pack', () => {
    const root = pathResolver.rootResolve(`active/shared/tmp/facet-pack-test-${Date.now()}`);
    const pluginRoot = path.join(root, 'pack-one');
    try {
      safeMkdir(path.join(pluginRoot, 'facets', 'personas'), { recursive: true });
      safeWriteFile(
        path.join(pluginRoot, 'plugin.json'),
        JSON.stringify({ plugin_id: 'pack-one', facets: { persona: ['pack-persona'] } })
      );
      safeWriteFile(
        path.join(pluginRoot, '.kyberion-managed-plugin.json'),
        JSON.stringify({
          pluginId: 'pack-one',
          trust: 'official',
          trustReason: 'test',
          // KD-06: trust is re-derived from resolvedSourcePath on every read, so
          // this must resolve inside the repo's own plugins/ tree to stay 'official'.
          resolvedSourcePath: path.join(pathResolver.rootDir(), 'plugins', 'pack-one'),
          managedPath: pluginRoot,
          manifest: {
            pluginId: 'pack-one',
            raw: { plugin_id: 'pack-one', facets: { persona: ['pack-persona'] } },
          },
          diagnostics: [],
          activationStatus: 'activatable',
          installedAt: new Date().toISOString(),
        })
      );
      safeWriteFile(
        path.join(pluginRoot, 'facets', 'personas', 'pack-persona.md'),
        'Managed pack persona content.'
      );
      const resolved = resolveFacets(
        { persona: 'pack-persona' },
        { tier: 'public', managedRoot: root }
      );
      expect(resolved.persona?.source).toBe('managed');
      expect(resolved.persona?.content).toContain('Managed pack');
    } finally {
      safeRmSync(root);
    }
  });

  it('rejects a managed facet that resolves through a symlink', () => {
    const root = pathResolver.rootResolve(`active/shared/tmp/facet-symlink-test-${Date.now()}`);
    const pluginRoot = path.join(root, 'pack-one');
    const targetPath = path.join(root, 'outside.md');
    const linkPath = path.join(pluginRoot, 'facets', 'personas', 'linked-persona.md');
    try {
      safeMkdir(path.dirname(linkPath), { recursive: true });
      safeWriteFile(targetPath, 'Outside managed facet content.');
      safeWriteFile(
        path.join(pluginRoot, 'plugin.json'),
        JSON.stringify({ plugin_id: 'pack-one', facets: { persona: ['linked-persona'] } })
      );
      safeWriteFile(
        path.join(pluginRoot, '.kyberion-managed-plugin.json'),
        JSON.stringify({
          pluginId: 'pack-one',
          trust: 'official',
          trustReason: 'test',
          resolvedSourcePath: path.join(pathResolver.rootDir(), 'plugins', 'pack-one'),
          managedPath: pluginRoot,
          manifest: {
            pluginId: 'pack-one',
            raw: { plugin_id: 'pack-one', facets: { persona: ['linked-persona'] } },
          },
          diagnostics: [],
          activationStatus: 'activatable',
          installedAt: new Date().toISOString(),
        })
      );
      safeSymlinkSync(targetPath, linkPath);

      expect(() =>
        resolveFacets({ persona: 'linked-persona' }, { tier: 'public', managedRoot: root })
      ).toThrow(/RESOURCE_PATH_SYMLINK|symlink/i);
    } finally {
      safeRmSync(root);
    }
  });

  it('detects impurity by facet kind', () => {
    expect(
      validateFacetPurity({ kind: 'persona', content: 'Standard Procedures\n1. do this' })
    ).toContain('persona facet contains procedural instructions');
    expect(validateFacetPurity({ kind: 'policy', content: 'Response format: JSON' })).toContain(
      'policy facet contains output-format instructions'
    );
  });

  it('resolves an authorized virtual plugin facet with provenance and disposes it', () => {
    const dispose = registerPluginFacet({
      name: 'virtual-policy',
      metadata: { kind: 'policy', content: 'Virtual plugin policy.' },
      provenance: {
        pluginId: 'facet-test-plugin',
        sourcePath: '/managed/facet-test/index.mjs',
        trust: 'official',
      },
    });
    try {
      expect(
        resolveFacets({ policies: ['virtual-policy'] }, { tier: 'public' }).policies[0]
      ).toMatchObject({
        source: 'plugin',
        content: 'Virtual plugin policy.',
        provenance: { plugin_id: 'facet-test-plugin', trust: 'official' },
      });
    } finally {
      dispose();
    }
    expect(() => resolveFacets({ policies: ['virtual-policy'] }, { tier: 'public' })).toThrow(
      '[FACET_NOT_FOUND]'
    );
  });
});
