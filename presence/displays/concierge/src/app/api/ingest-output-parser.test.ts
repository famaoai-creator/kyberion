import { describe, expect, it } from 'vitest';
import { assetProvenanceRef, deriveAssetId } from '@agent/core/ingest-asset-ledger';
import { parseIngestCliVerdict } from './ingest-output-parser.js';

const target = 'knowledge/confidential/acme/ingest/note.md';
const expected = { dryRun: false, tenant: 'acme', sourceId: 'note.md' };
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
const previewMarker = '[ingest] DRY RUN — no card written, no ledger record appended';
const duplicateMarker = '[ingest] NOT committed (duplicate) — the ledger is unchanged';
const commitMarker = `[ingest] committed ${assetProvenanceRef(asset)} → ${target}`;
const output = (marker: string, receipt: unknown) =>
  `${marker}\n${JSON.stringify(receipt, null, 2)}\n`;

describe('parseIngestCliVerdict', () => {
  it('accepts preview decisions and the CLI optional landing guidance', () => {
    for (const would_commit of [true, false]) {
      const stdout = output(previewMarker, { ...plan, would_commit });
      for (const text of [
        stdout,
        stdout.replace(
          '\n',
          '\n[ingest] no --target given: the card would land in ingest/. Existing folders in acme: (none)\n'
        ),
      ]) {
        expect(parseIngestCliVerdict(text, { ...expected, dryRun: true })).toEqual({
          outcome: would_commit ? 'would_commit' : 'duplicate',
          target_path: target,
        });
      }
    }
  });
  it('accepts committed assets, versioned prior targets and nested knowledge roots', () => {
    for (const record of [
      asset,
      {
        ...asset,
        version: 2,
        supersedes: `${asset.asset_id}@v1`,
        target_path: 'knowledge/confidential/acme/custom/reports/original.md',
      },
    ]) {
      const marker = `[ingest] committed ${assetProvenanceRef(record)} → ${record.target_path}`;
      expect(
        parseIngestCliVerdict(`diagnostic before the verdict\n${output(marker, record)}`, expected)
      ).toEqual({
        outcome: 'committed',
        target_path: record.target_path,
      });
    }
  });
  it('accepts explicit duplicate without demanding an existing row or source match', () => {
    expect(
      parseIngestCliVerdict(
        output(duplicateMarker, {
          committed: false,
          reason: 'duplicate',
          target_path: target,
        }),
        { ...expected, sourceId: 'another-name.md' }
      )
    ).toEqual({ outcome: 'duplicate', target_path: target });
  });
  it.each([
    '',
    commitMarker,
    `${commitMarker}\n{`,
    output(commitMarker, []),
    output(commitMarker, {}),
    `ordinary log mentions ${output(commitMarker, asset)}`,
    output(commitMarker, asset) + 'trailing noise',
    `${duplicateMarker}\n${output(commitMarker, asset)}`,
    `${previewMarker}\n${output(commitMarker, asset)}`,
    output(`${commitMarker} extra`, asset),
    output(commitMarker.replace('@v1', '@v2'), asset),
    output(commitMarker.replace('note.md', 'wrong.md'), asset),
    output(previewMarker, plan),
    output(duplicateMarker, { committed: false, reason: 'blocked', target_path: target }),
    output(duplicateMarker, { committed: true, reason: 'duplicate', target_path: target }),
    `${commitMarker}\n${JSON.stringify(asset).replace('"status":"active"', '"status":"active","metadata":{"constructor":{}}')}`,
  ])('rejects invalid or contradictory output %#', (stdout) => {
    expect(parseIngestCliVerdict(stdout, expected)).toBeNull();
  });
  it.each([
    { source_id: 'another.md' },
    { source_system: 'other' },
    { ingested_by: 'other' },
    { visible_to: ['other'] },
    { visible_to: ['acme', 'other'] },
    { status: 'superseded' },
    { version: 0 },
    { version: 1.5 },
    { content_sha256: 'invalid' },
    { transform_chain: [] },
    { dry_run: true },
    { would_commit: true },
    { committed: false },
    { committed: true },
  ])('rejects mismatched or malformed committed field %#', (patch) => {
    expect(
      parseIngestCliVerdict(output(commitMarker, { ...asset, ...patch }), expected)
    ).toBeNull();
  });
  it.each(Object.keys(asset))('requires complete committed field %s', (field) => {
    const receipt: Record<string, unknown> = { ...asset };
    delete receipt[field];
    expect(parseIngestCliVerdict(output(commitMarker, receipt), expected)).toBeNull();
  });
  it.each([
    { would_commit: undefined },
    { would_commit: null },
    { would_commit: 'false' },
    { dry_run: false },
    { tenant_slug: 'other' },
    { asset_id: 'wrong' },
    { ingested_by: 'other' },
    { content_sha256: 'bad' },
    { committed: false },
  ])('rejects incomplete or mismatched preview %#', (patch) => {
    expect(
      parseIngestCliVerdict(output(previewMarker, { ...plan, ...patch }), {
        ...expected,
        dryRun: true,
      })
    ).toBeNull();
  });
  it.each([
    '',
    'knowledge/confidential/acme',
    'knowledge/confidential/acme/',
    'knowledge/confidential/acme-other/note.md',
    'knowledge/confidential/other/note.md',
    'knowledge/confidential/acme/../other/note.md',
    'knowledge/confidential/acme/./note.md',
    '/knowledge/confidential/acme/note.md',
    'C:\\knowledge\\confidential\\acme\\note.md',
    'knowledge/confidential/acme//note.md',
  ])('rejects unsafe or wrong-tenant target %s in every phase', (target_path) => {
    expect(
      parseIngestCliVerdict(output(previewMarker, { ...plan, target_path }), {
        ...expected,
        dryRun: true,
      })
    ).toBeNull();
    expect(
      parseIngestCliVerdict(output(commitMarker, { ...asset, target_path }), expected)
    ).toBeNull();
    expect(
      parseIngestCliVerdict(
        output(duplicateMarker, { committed: false, reason: 'duplicate', target_path }),
        expected
      )
    ).toBeNull();
  });
  it('accepts CRLF receipt envelopes without changing the parsed target', () => {
    const stdout = output(commitMarker, asset).replaceAll('\n', '\r\n');
    expect(parseIngestCliVerdict(stdout, expected)).toEqual({
      outcome: 'committed',
      target_path: target,
    });
  });

  it('does not accept a committed receipt during a preview request', () => {
    expect(
      parseIngestCliVerdict(output(commitMarker, asset), { ...expected, dryRun: true })
    ).toBeNull();
  });
});
