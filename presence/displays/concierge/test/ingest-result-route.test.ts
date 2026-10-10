import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { assetProvenanceRef, deriveAssetId } from '@agent/core/ingest-asset-ledger';

const child = vi.hoisted(() => ({ status: 0, stdout: '', stderr: '' }));
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: { tenantSlugs: ['acme'] } }),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: () => ['acme'],
}));
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExistsSync: () => true,
  safeLstat: () => ({ isFile: () => true }),
  safeMkdir: () => undefined,
  safeWriteFile: () => undefined,
  safeRmSync: () => undefined,
  safeExecResult: () => child,
}));

const target = 'knowledge/confidential/acme/ingest/note.md';
const asset = {
  asset_id: deriveAssetId('concierge-upload', 'note.md'),
  source_system: 'concierge-upload',
  source_id: 'note.md',
  content_sha256: 'a'.repeat(64),
  retrieved_at: '2026-10-10T00:00:00Z',
  ingested_at: '2026-10-10T00:00:00Z',
  ingested_by: 'sovereign_concierge:web',
  visible_to: ['acme'],
  transform_chain: ['parse_document:markdown', 'normalize_card'],
  target_path: target,
  version: 1,
  status: 'active',
};
const plan = {
  dry_run: true,
  tenant_slug: 'acme',
  asset_id: asset.asset_id,
  target_path: target,
  content_sha256: asset.content_sha256,
  would_commit: true,
  ingested_by: asset.ingested_by,
};
const output = (marker: string, receipt: unknown) =>
  `${marker}\n${JSON.stringify(receipt, null, 2)}\n`;
const previewMarker = '[ingest] DRY RUN — no card written, no ledger record appended';
const commitMarker = `[ingest] committed ${assetProvenanceRef(asset)} → ${target}`;
const duplicateMarker = '[ingest] NOT committed (duplicate) — the ledger is unchanged';
async function submit(dryRun: boolean) {
  const { POST } = await import('../src/app/api/ingest/route');
  const body = new FormData();
  body.set('file', new File(['# note'], 'note.md', { type: 'text/markdown' }));
  body.set('tenant', 'acme');
  if (dryRun) body.set('dry_run', 'true');
  return POST(
    new NextRequest('http://localhost/api/ingest', {
      method: 'POST',
      body,
      headers: { 'accept-language': 'en' },
    })
  );
}
beforeEach(() => {
  child.status = 0;
  child.stdout = '';
  child.stderr = '';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('ingest route verified results', () => {
  it.each([
    [true, 'would_commit', output(previewMarker, plan)],
    [true, 'duplicate', output(previewMarker, { ...plan, would_commit: false })],
    [false, 'committed', output(commitMarker, asset)],
    [
      false,
      'duplicate',
      output(duplicateMarker, { committed: false, reason: 'duplicate', target_path: target }),
    ],
  ])('projects valid dryRun=%s %s receipts', async (dryRun, outcome, stdout) => {
    child.stdout = stdout;
    const response = await submit(dryRun);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      summary: {
        dry_run: dryRun,
        outcome,
        tenant: 'acme',
        file_name: 'note.md',
      },
    });
  });

  it.each([
    ['commit marker only', false, commitMarker],
    ['malformed committed JSON', false, `${commitMarker}\n{"target_path":`],
    ['missing committed asset', false, output(commitMarker, {})],
    ['duplicate marker only', false, duplicateMarker],
    [
      'wrong non-write reason',
      false,
      output(duplicateMarker, { committed: false, reason: 'blocked', target_path: target }),
    ],
    ['missing preview decision', true, output(previewMarker, { ...plan, would_commit: undefined })],
    ['wrong preview tenant', true, output(previewMarker, { ...plan, tenant_slug: 'other' })],
    ['conflicting commit receipt', false, output(commitMarker, { ...asset, committed: false })],
    ['contradictory markers', false, `${duplicateMarker}\n${output(commitMarker, asset)}`],
  ])('returns uncertain-capable 502 for %s', async (_name, dryRun, stdout) => {
    child.stdout = stdout;
    const response = await submit(dryRun);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.summary).toBeUndefined();
  });
});
