import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import {
  approvalStoreRoots,
  decideApprovalRequest,
  loadApprovalRequest,
} from './governance/approval-store.js';
import {
  installPluginManaged,
  refreshManagedPluginActivation,
  type ManagedPluginRecord,
} from './plugin/plugin-managed-install.js';
import { registerPluginFacet, resolveFacets, validateFacetPurity } from './facet-registry.js';

const FIXTURE_ROOT = pathResolver.sharedTmp('facet-registry-test');
const cleanupPaths: string[] = [];

function tracked(target: string): string {
  cleanupPaths.push(target);
  return target;
}

afterEach(() => {
  // Managed-plugin paths are only writable under the authority role the
  // installer itself uses; test cleanup needs the same wrapper.
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) {
      safeRmSync(cleanupPaths.pop() as string);
    }
    for (const root of Object.values(approvalStoreRoots())) {
      safeRmSync(path.join(root, 'plugin-install'), { recursive: true, force: true });
    }
  });
});

// Leave nothing behind under active/shared/tmp, not even the empty parent.
afterAll(() => withExecutionContext('mission_controller', () => safeRmSync(FIXTURE_ROOT)));

/**
 * Install a pack the way the managed installer does and take it through a real
 * human approval, because provenance verification now refuses to honour a
 * hand-written `trust: official` record that does not come from `plugins/`.
 */
function installApprovedPack(params: {
  pluginId: string;
  sourcePath: string;
  managedRoot: string;
}): ManagedPluginRecord {
  const record = installPluginManaged({ ...params, requestedBy: 'facet-registry-test' });
  const pending = loadApprovalRequest(
    record.approvalChannel as string,
    record.approvalRequestId as string
  );
  decideApprovalRequest('mission_controller', {
    channel: record.approvalChannel as string,
    requestId: record.approvalRequestId as string,
    decision: 'approved',
    decidedBy: 'human:operator',
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    payloadHash: pending?.accountability?.payloadHash,
    effectBinding: pending?.accountability?.effectBinding,
  });
  const refreshed = refreshManagedPluginActivation(params.pluginId, params.managedRoot);
  if (!refreshed || refreshed.activationStatus !== 'activatable') {
    throw new Error(`test pack did not become activatable: ${refreshed?.activationStatus}`);
  }
  return refreshed;
}

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
    const id = randomUUID();
    const sourcePath = tracked(path.join(FIXTURE_ROOT, `pack-source-${id}`));
    const managedRoot = tracked(path.join(FIXTURE_ROOT, `pack-managed-${id}`));

    safeMkdir(path.join(sourcePath, 'facets', 'personas'), { recursive: true });
    safeWriteFile(
      path.join(sourcePath, 'plugin.json'),
      JSON.stringify({ plugin_id: 'pack-one', facets: { persona: ['pack-persona'] } })
    );
    safeWriteFile(
      path.join(sourcePath, 'facets', 'personas', 'pack-persona.md'),
      'Managed pack persona content.'
    );
    const installed = installApprovedPack({
      pluginId: `facet-pack-${id}`,
      sourcePath,
      managedRoot,
    });

    const resolved = resolveFacets({ persona: 'pack-persona' }, { tier: 'public', managedRoot });
    expect(resolved.persona?.source).toBe('managed');
    expect(resolved.persona?.content).toContain('Managed pack');

    // Mutating an approved pack invalidates its content provenance before the
    // facet read boundary; it must no longer be selectable.
    const managedFacetPath = path.join(
      installed.managedPath,
      'facets',
      'personas',
      'pack-persona.md'
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(managedFacetPath);
      safeMkdir(managedFacetPath, { recursive: true });
    });
    expect(() =>
      resolveFacets({ persona: 'pack-persona' }, { tier: 'public', managedRoot })
    ).toThrow('[FACET_NOT_FOUND]');
  });

  it('rejects a managed facet that resolves through a symlink', () => {
    const id = randomUUID();
    const sourcePath = tracked(path.join(FIXTURE_ROOT, `link-source-${id}`));
    const managedRoot = tracked(path.join(FIXTURE_ROOT, `link-managed-${id}`));
    const outsidePath = tracked(path.join(FIXTURE_ROOT, `outside-${id}.md`));

    safeMkdir(path.join(sourcePath, 'facets', 'personas'), { recursive: true });
    safeWriteFile(
      path.join(sourcePath, 'plugin.json'),
      JSON.stringify({ plugin_id: 'pack-one', facets: { persona: ['linked-persona'] } })
    );
    safeWriteFile(outsidePath, 'Outside managed facet content.');
    const installed = installApprovedPack({
      pluginId: `facet-link-${id}`,
      sourcePath,
      managedRoot,
    });

    // Adding the declared facet as a link after approval must fail provenance
    // verification or the symlink read boundary before any content is read.
    const linkPath = path.join(installed.managedPath, 'facets', 'personas', 'linked-persona.md');
    withExecutionContext('mission_controller', () => {
      safeMkdir(path.dirname(linkPath), { recursive: true });
      safeSymlinkSync(outsidePath, linkPath);
    });

    expect(() =>
      resolveFacets({ persona: 'linked-persona' }, { tier: 'public', managedRoot })
    ).toThrow(/FACET_NOT_FOUND|RESOURCE_PATH_SYMLINK|symlink/i);
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
