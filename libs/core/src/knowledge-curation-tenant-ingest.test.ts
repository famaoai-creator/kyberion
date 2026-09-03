/**
 * DA-08: tenant-ingested cards join the KP-06 weekly curation cycle —
 * hermetic tests for the per-tenant ingest freshness section (ledger-driven,
 * advisory only) and its rendering inside CURATION_REPORT.md.
 *
 * Fixture tenant registry + ledgers live under a fixture rootDir in
 * active/shared/tmp via the ingest-ledger path seam (same convention as the
 * ingest-actuator commit tests).
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  computeTenantIngestCuration,
  TENANT_INGEST_DEFAULT_KIND,
} from './knowledge-curation-tenant-ingest.js';
import { deriveAssetId } from '../ingest-asset-ledger.js';
import {
  renderCurationReportMarkdown,
  type CurationSloConfig,
  type KnowledgeCurationReport,
} from './knowledge-curation-report.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const NOW = new Date('2026-07-28T00:00:00.000Z');

const CONFIG: CurationSloConfig = {
  low_yield_delivery_threshold: 5,
  freshness_days_by_kind: { governance: 90, playbook: 60, knowledge_hint: 30, reference: 120 },
  default_freshness_days: 180,
};

let fixtureRoot = '';
let options: { rootDir: string; env: NodeJS.ProcessEnv };

function ledgerLine(overrides: Record<string, unknown>): string {
  const record = {
    asset_id: 'ing-x',
    source_system: 'confluence',
    source_id: 'PAGE-X',
    content_sha256: 'a'.repeat(64),
    retrieved_at: '2026-01-01T00:00:00.000Z',
    ingested_at: '2026-01-01T00:00:00.000Z',
    ingested_by: 'tester',
    visible_to: ['acme-corp'],
    transform_chain: ['normalize_card'],
    target_path: 'knowledge/confidential/acme-corp/reports/x.md',
    version: 1,
    status: 'active',
    ...overrides,
  };
  return JSON.stringify({
    ...record,
    asset_id: deriveAssetId(String(record.source_system), String(record.source_id)),
  });
}

function writeFixtureFile(repoRelative: string, content: string): void {
  const filePath = path.join(fixtureRoot, ...repoRelative.split('/'));
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, content);
}

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `curation-tenant-ingest-da08-${randomUUID()}`
  );
  options = { rootDir: fixtureRoot, env: EMPTY_ENV };
  for (const slug of ['acme-corp', 'other-co']) {
    writeFixtureFile(
      `knowledge/personal/tenants/${slug}.json`,
      JSON.stringify(
        { tenant_slug: slug, display_name: slug, status: 'active', assigned_role: 'owner' },
        null,
        2
      )
    );
  }
});

afterAll(() => {
  if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('computeTenantIngestCuration', () => {
  it('flags stale cards by frontmatter last_updated, falls back to ingested_at, skips fresh ones', () => {
    // Asset 1: card with an old last_updated (kind reference → 120d SLO) — stale.
    writeFixtureFile(
      'knowledge/confidential/acme-corp/reports/stale.md',
      ['---', 'kind: reference', 'last_updated: 2026-01-01', '---', '', '# Stale'].join('\n')
    );
    // Asset 2: card with a fresh last_updated — not flagged.
    writeFixtureFile(
      'knowledge/confidential/acme-corp/reports/fresh.md',
      ['---', 'kind: reference', 'last_updated: 2026-07-01', '---', '', '# Fresh'].join('\n')
    );
    // Asset 3: card file missing → the ledger's ingested_at backstops (old → stale).
    writeFixtureFile(
      'knowledge/confidential/acme-corp/_ledger/assets.jsonl',
      [
        ledgerLine({
          asset_id: 'ing-stale',
          source_id: 'PAGE-STALE',
          target_path: 'knowledge/confidential/acme-corp/reports/stale.md',
        }),
        ledgerLine({
          asset_id: 'ing-fresh',
          source_id: 'PAGE-FRESH',
          ingested_at: '2026-07-01T00:00:00.000Z',
          target_path: 'knowledge/confidential/acme-corp/reports/fresh.md',
        }),
        ledgerLine({
          asset_id: deriveAssetId('confluence', 'PAGE-GONE'),
          source_id: 'PAGE-GONE',
          ingested_at: '2025-12-01T00:00:00.000Z',
          target_path: 'knowledge/confidential/acme-corp/reports/gone.md',
        }),
      ].join('\n') + '\n'
    );

    const sections = computeTenantIngestCuration({
      config: CONFIG,
      now: NOW,
      tenants: ['acme-corp', 'other-co'],
      pathOptions: options,
    });

    // other-co has no ledger → omitted entirely (stable report while empty).
    expect(sections).toHaveLength(1);
    expect(sections[0].tenant_slug).toBe('acme-corp');
    expect(sections[0].active_asset_count).toBe(3);
    expect(sections[0].flagged).toEqual([
      {
        tenant_slug: 'acme-corp',
        asset_id: deriveAssetId('confluence', 'PAGE-STALE'),
        target_path: 'knowledge/confidential/acme-corp/reports/stale.md',
        kind: TENANT_INGEST_DEFAULT_KIND,
        last_updated: '2026-01-01',
        age_days: expect.any(Number),
        threshold_days: 120,
        reason: 'stale',
      },
      {
        tenant_slug: 'acme-corp',
        asset_id: deriveAssetId('confluence', 'PAGE-GONE'),
        target_path: 'knowledge/confidential/acme-corp/reports/gone.md',
        kind: 'reference',
        last_updated: '2025-12-01T00:00:00.000Z',
        age_days: expect.any(Number),
        threshold_days: 120,
        reason: 'stale',
      },
    ]);
  });

  it('is advisory and fail-open: an unregistered tenant is skipped, never thrown', () => {
    const sections = computeTenantIngestCuration({
      config: CONFIG,
      now: NOW,
      tenants: ['ghost-co'],
      pathOptions: options,
    });
    expect(sections).toEqual([]);
  });

  it('rejects an external tenant-ingest fixture root before ledger access', () => {
    const key = 'KYBERION_CURATION_TENANT_ROOTDIR';
    const previous = process.env[key];
    process.env[key] = '/tmp/external-curation-root';
    try {
      expect(() =>
        computeTenantIngestCuration({ config: CONFIG, now: NOW, tenants: ['acme-corp'] })
      ).toThrow('RESOURCE_PATH_SCOPE');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe('renderCurationReportMarkdown — tenant ingest section', () => {
  function reportWith(
    tenantIngest: KnowledgeCurationReport['tenant_ingest']
  ): KnowledgeCurationReport {
    return {
      generated_at: NOW.toISOString(),
      config: CONFIG,
      low_yield_hints: [],
      freshness_breaches: [],
      tenant_ingest: tenantIngest,
      scanned_document_count: 0,
      summary: {
        low_yield_count: 0,
        freshness_breach_count: 0,
        tenant_ingest_flagged_count: tenantIngest.reduce((sum, s) => sum + s.flagged.length, 0),
      },
    };
  }

  it('renders flagged assets per tenant and (none) when nothing is flagged', () => {
    const empty = renderCurationReportMarkdown(reportWith([]));
    expect(empty).toContain('## Tenant Ingest Freshness (DA-08)');
    expect(empty).toContain('_(none)_');

    const rendered = renderCurationReportMarkdown(
      reportWith([
        {
          tenant_slug: 'acme-corp',
          active_asset_count: 3,
          flagged: [
            {
              tenant_slug: 'acme-corp',
              asset_id: deriveAssetId('confluence', 'PAGE-STALE'),
              target_path: 'knowledge/confidential/acme-corp/reports/stale.md',
              kind: 'reference',
              last_updated: '2026-01-01',
              age_days: 208,
              threshold_days: 120,
              reason: 'stale',
            },
          ],
        },
      ])
    );
    expect(rendered).toContain('### acme-corp (1 of 3 active asset(s))');
    expect(rendered).toContain(`| ${deriveAssetId('confluence', 'PAGE-STALE')} |`);
    expect(rendered).toContain('| reference | 2026-01-01 | 208 | 120 | stale |');
  });
});
