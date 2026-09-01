// DA-05 acceptance (2): lineage (source → transform chain → approval) is
// reconstructible from the ledger over a 3-version chain; acceptance (4):
// staleness_report detects updated sources. Hermetic: tenant profile and
// ledger live under a fixture rootDir in active/shared/tmp via the
// TenantRegistryPathOptions seam — no real knowledge/ file is touched.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAssetRecord,
  assetLedgerPath,
  assetLineage,
  assetProvenanceRef,
  deriveAssetId,
  findAssetByContentHash,
  findAssetBySource,
  listAssets,
  normalizeIngestAssetRecord,
  readAssetLedger,
  stalenessReport,
  tenantIngestKnowledgeRoot,
  type IngestAssetRecord,
} from './ingest-asset-ledger.js';
import * as pathResolver from './path-resolver.js';
import {
  safeAppendFile,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv; // no KYBERION_CUSTOMER → personal tenants dir
const HASH_V1 = 'a'.repeat(64);
const HASH_V2 = 'b'.repeat(64);
const HASH_V3 = 'c'.repeat(64);

function makeRecord(overrides: Partial<IngestAssetRecord> = {}): IngestAssetRecord {
  const sourceSystem = overrides.source_system ?? 'confluence';
  const sourceId = overrides.source_id ?? 'PAGE-1';
  return {
    asset_id: deriveAssetId(sourceSystem, sourceId),
    source_system: sourceSystem,
    source_id: sourceId,
    source_url: 'https://confluence.example.com/PAGE-1',
    source_version: '1',
    content_sha256: HASH_V1,
    retrieved_at: '2026-07-20T00:00:00.000Z',
    ingested_at: '2026-07-28T00:00:00.000Z',
    ingested_by: 'ecosystem_architect',
    visible_to: ['acme-corp'],
    transform_chain: ['parse_document:docx', 'normalize_card'],
    target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    version: 1,
    status: 'active',
    ...overrides,
  };
}

describe('ingest-asset-ledger (DA-05)', () => {
  let fixtureRoot = '';
  let symlinkFixtureRoot = '';
  let options: { rootDir: string; env: NodeJS.ProcessEnv };

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `ingest-ledger-da05-${randomUUID()}`
    );
    symlinkFixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `ingest-ledger-symlink-${randomUUID()}`
    );
    options = { rootDir: fixtureRoot, env: EMPTY_ENV };
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
  });

  afterAll(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
    if (symlinkFixtureRoot) safeRmSync(symlinkFixtureRoot, { recursive: true, force: true });
  });

  it('derives a stable asset_id from source_system::source_id', () => {
    const first = deriveAssetId('confluence', 'PAGE-1');
    expect(first).toMatch(/^ing-[a-f0-9]{16}$/);
    expect(deriveAssetId('confluence', 'PAGE-1')).toBe(first);
    expect(deriveAssetId('confluence', 'PAGE-2')).not.toBe(first);
    expect(deriveAssetId('box', 'PAGE-1')).not.toBe(first);
  });

  it('resolves the ledger path under the tenant knowledge root (and common without a profile)', () => {
    expect(assetLedgerPath('acme-corp', options)).toBe(
      path.join(fixtureRoot, 'knowledge/confidential/acme-corp/_ledger/assets.jsonl')
    );
    expect(tenantIngestKnowledgeRoot('common', options)).toBe('knowledge/confidential/common');
    expect(() => assetLedgerPath('ghost-co', options)).toThrow(/has no profile/);
  });

  it('appends validated records and rejects malformed ones fail-closed', () => {
    appendAssetRecord('acme-corp', makeRecord(), options);
    expect(() =>
      appendAssetRecord('acme-corp', makeRecord({ content_sha256: 'not-a-hash' }), options)
    ).toThrow(/content_sha256 must be a sha256/);
    expect(() =>
      appendAssetRecord('acme-corp', makeRecord({ asset_id: 'ing-0000000000000000' }), options)
    ).toThrow(/does not match deriveAssetId/);
    expect(() => appendAssetRecord('acme-corp', makeRecord({ visible_to: [] }), options)).toThrow(
      /visible_to must be a non-empty array/
    );
    expect(() =>
      appendAssetRecord(
        'acme-corp',
        makeRecord({
          target_path: path.relative(
            options.rootDir,
            path.join(pathResolver.rootDir(), '..', 'outside-knowledge.md')
          ),
        }),
        options
      )
    ).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(readAssetLedger('acme-corp', options)).toHaveLength(1);
  });

  it('reconstructs full lineage (source → transform chain → approval) over a 3-version chain', () => {
    const assetId = deriveAssetId('confluence', 'PAGE-1');
    appendAssetRecord(
      'acme-corp',
      makeRecord({
        content_sha256: HASH_V2,
        source_version: '2',
        version: 2,
        supersedes: `${assetId}@v1`,
        transform_chain: ['parse_document:docx', 'pii_scrub', 'normalize_card'],
        ingested_at: '2026-07-29T00:00:00.000Z',
      }),
      options
    );
    appendAssetRecord(
      'acme-corp',
      makeRecord({
        content_sha256: HASH_V3,
        source_version: '3',
        version: 3,
        supersedes: `${assetId}@v2`,
        approval_id: 'APPROVAL-42',
        ingested_at: '2026-07-30T00:00:00.000Z',
      }),
      options
    );

    const lineage = assetLineage('acme-corp', assetId, options);
    expect(lineage).toHaveLength(3);
    expect(lineage.map((record) => record.version)).toEqual([1, 2, 3]);
    // Resolved statuses: everything but the newest version is superseded.
    expect(lineage.map((record) => record.status)).toEqual(['superseded', 'superseded', 'active']);
    expect(lineage.map((record) => record.supersedes)).toEqual([
      undefined,
      `${assetId}@v1`,
      `${assetId}@v2`,
    ]);
    // Source, transform chain, and approval all recoverable per version.
    expect(lineage[1].transform_chain).toEqual([
      'parse_document:docx',
      'pii_scrub',
      'normalize_card',
    ]);
    expect(lineage[2].approval_id).toBe('APPROVAL-42');
    expect(lineage.every((record) => record.source_system === 'confluence')).toBe(true);
    // History lines were appended, never rewritten.
    const rawLines = String(
      safeReadFile(assetLedgerPath('acme-corp', options), { encoding: 'utf8' })
    )
      .split('\n')
      .filter(Boolean);
    expect(rawLines).toHaveLength(3);
    expect((JSON.parse(rawLines[0]) as IngestAssetRecord).status).toBe('active');
  });

  it('findAssetBySource returns the latest version; findAssetByContentHash matches any version', () => {
    const latest = findAssetBySource('acme-corp', 'confluence', 'PAGE-1', options);
    expect(latest?.version).toBe(3);
    expect(latest?.content_sha256).toBe(HASH_V3);
    expect(findAssetBySource('acme-corp', 'confluence', 'NOPE', options)).toBeNull();
    expect(findAssetByContentHash('acme-corp', HASH_V2, options)?.version).toBe(2);
    expect(findAssetByContentHash('acme-corp', 'f'.repeat(64), options)).toBeNull();
  });

  it('listAssets returns one latest record per asset, codepoint-sorted', () => {
    appendAssetRecord(
      'acme-corp',
      makeRecord({
        source_id: 'PAGE-2',
        asset_id: deriveAssetId('confluence', 'PAGE-2'),
        content_sha256: 'd'.repeat(64),
        target_path: 'knowledge/confidential/acme-corp/reports/q2.md',
      }),
      options
    );
    const assets = listAssets('acme-corp', options);
    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => asset.asset_id)).toEqual(
      [...assets.map((asset) => asset.asset_id)].sort()
    );
    const page1 = assets.find((asset) => asset.source_id === 'PAGE-1');
    expect(page1?.version).toBe(3);
  });

  it('formats KKP provenance refs as asset:{id}@v{n}', () => {
    const record = findAssetBySource('acme-corp', 'confluence', 'PAGE-1', options)!;
    expect(assetProvenanceRef(record)).toBe(`asset:${record.asset_id}@v3`);
  });

  it('stalenessReport detects updated sources by hash and by source_version (acceptance 4)', () => {
    const report = stalenessReport(
      'acme-corp',
      [
        // PAGE-1: source moved on (new hash) → stale.
        { source_system: 'confluence', source_id: 'PAGE-1', content_sha256: 'e'.repeat(64) },
        // PAGE-2: same hash, same version → fresh.
        {
          source_system: 'confluence',
          source_id: 'PAGE-2',
          content_sha256: 'd'.repeat(64),
          source_version: '1',
        },
      ],
      options
    );
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({
      source_id: 'PAGE-1',
      version: 3,
      ledger_content_sha256: HASH_V3,
      current_content_sha256: 'e'.repeat(64),
      reason: 'content_hash_mismatch',
    });

    const versionOnly = stalenessReport(
      'acme-corp',
      [{ source_system: 'confluence', source_id: 'PAGE-2', source_version: '9' }],
      options
    );
    expect(versionOnly.stale).toHaveLength(1);
    expect(versionOnly.stale[0].reason).toBe('source_version_mismatch');
  });

  it('stalenessReport with no observations dumps active assets deterministically', () => {
    const report = stalenessReport('acme-corp', [], options);
    expect(report.tenant_slug).toBe('acme-corp');
    expect(report.stale).toEqual([]);
    expect(report.assets).toHaveLength(2);
    expect(report.assets.every((asset) => asset.status === 'active')).toBe(true);
  });

  it('skips corrupt ledger lines instead of failing reads', () => {
    safeAppendFile(
      assetLedgerPath('acme-corp', options),
      ['not-json', '[]', JSON.stringify({ ...makeRecord(), visible_to: ['acme-corp', 42] })].join(
        '\n'
      ) + '\n'
    );
    expect(readAssetLedger('acme-corp', options)).toHaveLength(4);
    expect(listAssets('acme-corp', options)).toHaveLength(2);
  });

  it('skips dangerous ledger lines instead of projecting them', () => {
    const options = { rootDir: fixtureRoot };
    const ledger = assetLedgerPath('acme-corp', options);
    safeMkdir(path.dirname(ledger), { recursive: true });
    safeWriteFile(ledger, '{"nested":{"constructor":{}}}\n');

    expect(readAssetLedger('acme-corp', options)).toEqual([]);
  });

  it('normalizes only complete, tenant-contained asset records', () => {
    expect(normalizeIngestAssetRecord({ asset_id: 'ing-1' }, options)).toBeNull();
    expect(normalizeIngestAssetRecord(makeRecord(), options)).toMatchObject({
      asset_id: deriveAssetId('confluence', 'PAGE-1'),
      status: 'active',
    });
    expect(
      normalizeIngestAssetRecord(makeRecord({ target_path: '../outside.md' }), options)
    ).toBeNull();
  });

  it('rejects a symlinked tenant ledger directory before reading or appending', () => {
    const ledgerDir = path.join(symlinkFixtureRoot, 'knowledge/confidential/common/_ledger');
    const targetDir = path.join(symlinkFixtureRoot, 'ledger-target');
    safeMkdir(path.dirname(ledgerDir), { recursive: true });
    safeMkdir(targetDir, { recursive: true });
    safeSymlinkSync(targetDir, ledgerDir, 'dir');

    const symlinkOptions = { rootDir: symlinkFixtureRoot, env: EMPTY_ENV };
    expect(() => assetLedgerPath('common', symlinkOptions)).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => readAssetLedger('common', symlinkOptions)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
