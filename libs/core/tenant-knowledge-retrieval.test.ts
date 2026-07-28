import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  _resetTenantKnowledgeWarningsForTests,
  buildTenantKnowledgeScopeSet,
  queryTenantKnowledge,
} from './tenant-knowledge-retrieval.js';

// DA-07: isolation choke point tests. The fixture plants documents with the
// SAME distinctive topic terms under tenant-x, tenant-y, common, the
// customer/ overlay, and knowledge/personal/ — proving reachability is
// decided by the positively-constructed scope allowlist, never by scoring.

const fixtureRoot = pathResolver.sharedTmp(`da07-tenant-retrieval-${process.pid}`);
const kiCacheDir = pathResolver.sharedTmp(`da07-tenant-retrieval-ki-cache-${process.pid}`);
const fixtureEnv: NodeJS.ProcessEnv = {};

const TOPIC = 'quantum billing reconciliation';

function writeDoc(relPath: string, title: string): void {
  const abs = path.join(fixtureRoot, relPath);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(
    abs,
    [
      '---',
      `title: ${title}`,
      'tags: [quantum, billing]',
      'last_updated: 2026-07-01',
      '---',
      '',
      `${title}. Quantum billing reconciliation procedure for monthly close.`,
      '',
    ].join('\n')
  );
}

function writeTenantProfile(slug: string, strictIsolation: boolean): void {
  const abs = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants', `${slug}.json`);
  safeMkdir(path.dirname(abs), { recursive: true });
  safeWriteFile(
    abs,
    JSON.stringify(
      {
        tenant_slug: slug,
        display_name: `Tenant ${slug}`,
        status: 'active',
        assigned_role: 'owner',
        isolation_policy: { strict_isolation: strictIsolation, allow_cross_distillation: true },
      },
      null,
      2
    )
  );
}

function seedFixture(): void {
  writeTenantProfile('tenant-x', false);
  writeTenantProfile('tenant-strict', true);
  // Same topic terms everywhere — only the scope may decide reachability.
  writeDoc(
    'knowledge/confidential/tenant-x/quantum-billing-runbook.md',
    'Tenant X quantum billing runbook'
  );
  writeDoc(
    'knowledge/confidential/tenant-strict/quantum-billing-strict.md',
    'Strict tenant quantum billing note'
  );
  writeDoc(
    'knowledge/confidential/tenant-y/quantum-billing-shadow.md',
    'Tenant Y quantum billing quantum billing quantum billing reconciliation reconciliation'
  );
  writeDoc(
    'knowledge/confidential/common/quantum-billing-common.md',
    'Common quantum billing guidance'
  );
  writeDoc(
    'customer/tenant-x/quantum-billing-overlay.md',
    'Tenant X overlay quantum billing brief'
  );
  writeDoc('knowledge/personal/quantum-billing-private.md', 'Personal quantum billing secret');
}

let originalDisableEmbeddings: string | undefined;
let originalKiCacheDir: string | undefined;

beforeEach(() => {
  originalDisableEmbeddings = process.env.KYBERION_DISABLE_EMBEDDINGS;
  originalKiCacheDir = process.env.KYBERION_KI_CACHE_DIR;
  // Deterministic lexical-only retrieval; no ki-cache writes to the real cache dir.
  process.env.KYBERION_DISABLE_EMBEDDINGS = '1';
  process.env.KYBERION_KI_CACHE_DIR = kiCacheDir;
  _resetTenantKnowledgeWarningsForTests();
  seedFixture();
});

afterEach(() => {
  if (originalDisableEmbeddings === undefined) delete process.env.KYBERION_DISABLE_EMBEDDINGS;
  else process.env.KYBERION_DISABLE_EMBEDDINGS = originalDisableEmbeddings;
  if (originalKiCacheDir === undefined) delete process.env.KYBERION_KI_CACHE_DIR;
  else process.env.KYBERION_KI_CACHE_DIR = originalKiCacheDir;
  if (safeExistsSync(fixtureRoot)) safeRmSync(fixtureRoot, { recursive: true, force: true });
  if (safeExistsSync(kiCacheDir)) safeRmSync(kiCacheDir, { recursive: true, force: true });
});

describe('buildTenantKnowledgeScopeSet (positive allowlist)', () => {
  it('builds own-subtree + overlay + common scopes for a non-strict tenant', () => {
    const set = buildTenantKnowledgeScopeSet('tenant-x', { rootDir: fixtureRoot, env: fixtureEnv });
    expect(set).not.toBeNull();
    expect(set!.strictIsolation).toBe(false);
    expect(set!.scopes).toEqual([
      { tiers: ['confidential'], customerId: 'tenant-x' },
      { tiers: ['customer'], customerId: 'tenant-x' },
      { tiers: ['confidential'], customerId: 'common' },
    ]);
  });

  it('drops the common scope when strict_isolation is true', () => {
    const set = buildTenantKnowledgeScopeSet('tenant-strict', {
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    expect(set).not.toBeNull();
    expect(set!.strictIsolation).toBe(true);
    expect(set!.scopes).toEqual([
      { tiers: ['confidential'], customerId: 'tenant-strict' },
      { tiers: ['customer'], customerId: 'tenant-strict' },
    ]);
  });

  it('returns null (fail-open, nothing scanned) for an unregistered tenant', () => {
    expect(
      buildTenantKnowledgeScopeSet('tenant-unknown', { rootDir: fixtureRoot, env: fixtureEnv })
    ).toBeNull();
  });

  it('returns null for an invalid slug instead of throwing', () => {
    expect(
      buildTenantKnowledgeScopeSet('NOT A SLUG', { rootDir: fixtureRoot, env: fixtureEnv })
    ).toBeNull();
  });
});

describe('queryTenantKnowledge (reachability + isolation)', () => {
  it('reaches the tenant subtree, customer overlay, and common with repo-relative paths', async () => {
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-x',
      topic: TOPIC,
      limit: 10,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    const paths = hits.map((hit) => hit.path);
    expect(paths).toContain('knowledge/confidential/tenant-x/quantum-billing-runbook.md');
    expect(paths).toContain('customer/tenant-x/quantum-billing-overlay.md');
    expect(paths).toContain('knowledge/confidential/common/quantum-billing-common.md');
    for (const hit of hits) {
      expect(hit.tenant_slug).toBe('tenant-x');
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.excerpt.length).toBeGreaterThan(0);
    }
  });

  it("NEVER returns another tenant's document, even when it would outscore everything", async () => {
    // tenant-y's fixture doc repeats the query terms (highest lexical score
    // corpus-wide) — it must still be structurally unreachable.
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-x',
      topic: TOPIC,
      limit: 50,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    expect(hits.some((hit) => hit.path.includes('tenant-y'))).toBe(false);
  });

  it('never returns knowledge/personal/ content (overlay tier is overlay-only)', async () => {
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-x',
      topic: TOPIC,
      limit: 50,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    expect(hits.some((hit) => hit.path.startsWith('knowledge/personal/'))).toBe(false);
  });

  it('strict_isolation=true also drops knowledge/confidential/common', async () => {
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-strict',
      topic: TOPIC,
      limit: 50,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    const paths = hits.map((hit) => hit.path);
    expect(paths).toContain('knowledge/confidential/tenant-strict/quantum-billing-strict.md');
    expect(paths.some((p) => p.startsWith('knowledge/confidential/common/'))).toBe(false);
    expect(paths.some((p) => p.includes('tenant-x') || p.includes('tenant-y'))).toBe(false);
  });

  it('fails open to [] for an unregistered tenant', async () => {
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-unknown',
      topic: TOPIC,
      limit: 5,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    expect(hits).toEqual([]);
  });

  it('returns [] for a blank topic or a zero limit', async () => {
    expect(
      await queryTenantKnowledge({
        tenantSlug: 'tenant-x',
        topic: '   ',
        limit: 5,
        rootDir: fixtureRoot,
        env: fixtureEnv,
      })
    ).toEqual([]);
    expect(
      await queryTenantKnowledge({
        tenantSlug: 'tenant-x',
        topic: TOPIC,
        limit: 0,
        rootDir: fixtureRoot,
        env: fixtureEnv,
      })
    ).toEqual([]);
  });

  it('orders deterministically: score descending, ties by codepoint path order', async () => {
    const hits = await queryTenantKnowledge({
      tenantSlug: 'tenant-x',
      topic: TOPIC,
      limit: 10,
      rootDir: fixtureRoot,
      env: fixtureEnv,
    });
    for (let i = 1; i < hits.length; i += 1) {
      const prev = hits[i - 1];
      const curr = hits[i];
      expect(prev.score > curr.score || (prev.score === curr.score && prev.path < curr.path)).toBe(
        true
      );
    }
  });
});
