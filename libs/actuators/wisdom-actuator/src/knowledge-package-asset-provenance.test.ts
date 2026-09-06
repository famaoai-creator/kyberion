// DA-05: the KKP ⇄ information-asset-ledger connection
// (resolveIngestAssetProvenance lookup hook in knowledge/knowledge-package.ts).
//
// NOTE: this suite lives OUTSIDE src/knowledge/ on purpose — the root vitest
// config excludes '**/knowledge/**', so a test file placed next to
// knowledge-package.ts is never discovered (the pre-existing
// src/knowledge/knowledge-package.test.ts suite is affected by the same
// exclusion).
//
// Hermetic: tenant profile + ledger live under a fixture rootDir in
// active/shared/tmp via the ingest-ledger path seam.
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAssetRecord, deriveAssetId } from '@agent/core/ingest-asset-ledger';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  createKnowledgePackage,
  resolveIngestAssetProvenance,
} from './knowledge/knowledge-package.js';

describe('resolveIngestAssetProvenance (DA-05 KKP connection)', () => {
  const CONTENT_SHA = '1'.repeat(64);
  let fixtureRoot = '';
  let options: { rootDir: string; env: NodeJS.ProcessEnv };
  let assetId = '';

  const cardRawData = (sha: string) =>
    [
      '---',
      'title: Ingested Card',
      'source_system: confluence',
      'source_id: PAGE-7',
      `content_sha256: ${sha}`,
      '---',
      '',
      '# Ingested Card',
      '',
    ].join('\n');

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `kkp-asset-provenance-${randomUUID()}`
    );
    options = { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv };
    const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(tenantDir, { recursive: true });
    safeWriteFile(
      path.join(tenantDir, 'acme-corp.json'),
      JSON.stringify(
        {
          tenant_slug: 'acme-corp',
          display_name: 'Acme Corp',
          status: 'active',
          assigned_role: 'owner',
        },
        null,
        2
      )
    );
    assetId = deriveAssetId('confluence', 'PAGE-7');
    appendAssetRecord(
      'acme-corp',
      {
        asset_id: assetId,
        source_system: 'confluence',
        source_id: 'PAGE-7',
        content_sha256: CONTENT_SHA,
        retrieved_at: '2026-07-20T00:00:00.000Z',
        ingested_at: '2026-07-28T00:00:00.000Z',
        ingested_by: 'ecosystem_architect',
        visible_to: ['acme-corp'],
        transform_chain: ['parse_document:markdown', 'normalize_card'],
        target_path: 'knowledge/confidential/acme-corp/reports/q7.md',
        version: 1,
        status: 'active',
      },
      options
    );
  });

  afterAll(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
    delete process.env.KYBERION_A2A_SECRET;
  });

  it('resolves asset:{id}@v{n} from the frontmatter content_sha256', () => {
    expect(
      resolveIngestAssetProvenance({
        tenantSlug: 'acme-corp',
        rawData: cardRawData(CONTENT_SHA),
        pathOptions: options,
      })
    ).toBe(`asset:${assetId}@v1`);
  });

  it('falls back to source_system + source_id when the hash does not match', () => {
    expect(
      resolveIngestAssetProvenance({
        tenantSlug: 'acme-corp',
        rawData: cardRawData('2'.repeat(64)),
        pathOptions: options,
      })
    ).toBe(`asset:${assetId}@v1`);
  });

  it('returns null for non-ingested files and unregistered tenants (best-effort hook)', () => {
    expect(
      resolveIngestAssetProvenance({
        tenantSlug: 'acme-corp',
        rawData: '# No frontmatter here',
        pathOptions: options,
      })
    ).toBeNull();
    expect(
      resolveIngestAssetProvenance({
        tenantSlug: 'ghost-co',
        rawData: cardRawData(CONTENT_SHA),
        pathOptions: options,
      })
    ).toBeNull();
  });

  it('KKP provenance[] accepts the asset ref alongside the file path', () => {
    // First (and only) sign in this fork — the secret cache is still cold,
    // so setting the env here is sufficient (no reset needed).
    process.env.KYBERION_A2A_SECRET = 'knowledge-package-test-secret';
    const rawData = cardRawData(CONTENT_SHA);
    const ref = resolveIngestAssetProvenance({
      tenantSlug: 'acme-corp',
      rawData,
      pathOptions: options,
    })!;
    const pkg = createKnowledgePackage({
      packageId: 'KKP-asset-ref-1',
      originAgentId: 'agent-test',
      originTenantId: 'acme-corp',
      sourceTier: 'confidential',
      requestedTargetTier: 'confidential',
      contentHash: createHash('sha256').update(rawData).digest('hex'),
      createdAt: '2026-07-28T00:00:00.000Z',
      provenance: ['knowledge/confidential/acme-corp/reports/q7.md', ref],
      contentPath: 'knowledge/confidential/acme-corp/reports/q7.md',
      rawData,
    });
    expect(pkg.metadata.provenance).toEqual([
      'knowledge/confidential/acme-corp/reports/q7.md',
      `asset:${assetId}@v1`,
    ]);
  });
});
