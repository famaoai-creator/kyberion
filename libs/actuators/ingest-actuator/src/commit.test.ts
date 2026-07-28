// DA-05 acceptance (1): nothing lands in knowledge/confidential/ without the
// ingest ceremony — ingest:commit is the only ingest op that writes there,
// its path guard rejects escapes, and the security-policy grant is scoped to
// the ingest_commit role alone. Acceptance (3): a full
// parse → dedup → normalize → commit re-ingest with changed content becomes
// a SUPERSEDE (same target_path, version 2, supersedes ref, dedup registry
// consistent). Hermetic: tenant profile + ledger + landing root live under a
// fixture rootDir in active/shared/tmp via the path_options seam.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assetLineage,
  deriveAssetId,
  pathResolver,
  readAssetLedger,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  validateWritePermission,
  withExecutionContext,
} from '@agent/core';
import { commitIngest, INGEST_COMMIT_ROLE } from './commit.js';
import { dedupContent } from './dedup.js';
import { handleAction } from './index.js';
import { normalizeCard, type NormalizeCardResult } from './normalize-card.js';
import { INGEST_ACTUATOR_APPLY_OPS } from './op-catalog.js';
import { parseDocument } from './parse-document.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const NOW = '2026-07-28T09:00:00.000Z';
const IDENTITY_ENV_KEYS = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_TENANT',
  'MISSION_ID',
] as const;

let fixtureRoot = '';
let options: { rootDir: string; env: NodeJS.ProcessEnv };
let registryPath = '';
const savedEnv: Record<string, string | undefined> = {};

function normalizedCard(markdown: string, relativePath = 'reports/q1.md'): NormalizeCardResult {
  return normalizeCard({
    ir: {
      title: 'Ingest Commit Card',
      text_markdown: markdown,
      meta: {
        source_system: 'confluence',
        source_id: 'PAGE-1',
        source_url: 'https://confluence.example.com/PAGE-1',
        retrieved_at: '2026-07-20T00:00:00.000Z',
        format: 'markdown',
        content_sha256: 'a'.repeat(64),
        char_count: markdown.length,
      },
    },
    target: { tenant_slug: 'acme-corp', relative_path: relativePath },
    card: { kind: 'reference' },
    now: NOW,
    path_options: options,
  });
}

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `ingest-commit-da05-${randomUUID()}`
  );
  options = { rootDir: fixtureRoot, env: EMPTY_ENV };
  registryPath = path.join(fixtureRoot, 'content-hash-registry.jsonl');
  const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
  safeMkdir(tenantDir, { recursive: true });
  for (const slug of ['acme-corp', 'other-co']) {
    safeWriteFile(
      path.join(tenantDir, `${slug}.json`),
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

beforeEach(() => {
  for (const key of IDENTITY_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  delete process.env.KYBERION_TENANT;
  delete process.env.KYBERION_SUDO;
});

afterEach(() => {
  for (const key of IDENTITY_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('ingest:commit fail-closed path guard (DA-05 acceptance 1)', () => {
  it('rejects target paths outside the tenant knowledge root', () => {
    const card = normalizedCard('# Card\n\nBody.');
    for (const escape of [
      'knowledge/confidential/other-co/reports/q1.md', // another tenant
      'knowledge/confidential/acme-corp/../other-co/q1.md', // .. escape
      '/etc/passwd', // absolute
      'knowledge/public/q1.md', // public tier — needs a steward approval (DA-06)
      'active/shared/tmp/q1.md', // outside knowledge/
    ]) {
      expect(() =>
        commitIngest({
          tenant_slug: 'acme-corp',
          normalized: { ...card, target_path: escape },
          now: NOW,
          path_options: options,
        })
      ).toThrow(
        /outside the tenant knowledge root|must be repo-relative|must not contain|requires steward_approval_id/
      );
    }
    // Nothing was written by the rejected attempts.
    expect(readAssetLedger('acme-corp', options)).toHaveLength(0);
  });

  it('refuses an unregistered tenant (resolveTenant fail-closed)', () => {
    const card = normalizedCard('# Card\n\nBody.');
    expect(() =>
      commitIngest({
        tenant_slug: 'ghost-co',
        normalized: { ...card, target_path: 'knowledge/confidential/ghost-co/q1.md' },
        now: NOW,
        path_options: options,
      })
    ).toThrow(/has no profile/);
  });

  it('refuses anonymous ingests (no ingested_by and no identity context)', () => {
    for (const key of ['KYBERION_PERSONA', 'MISSION_ROLE'] as const) delete process.env[key];
    const card = normalizedCard('# Card\n\nBody.');
    expect(() =>
      commitIngest({ tenant_slug: 'acme-corp', normalized: card, now: NOW, path_options: options })
    ).toThrow(/ingested_by is required/);
  });

  it('commit is the only apply op this actuator declares', () => {
    expect([...INGEST_ACTUATOR_APPLY_OPS]).toEqual(['commit']);
  });
});

describe('ingest_commit security-policy grant scoping (DA-05 acceptance 1)', () => {
  it('is granted knowledge/confidential/ and the public ingest subtree only, no broader scope', () => {
    const policy = JSON.parse(
      safeReadFile(pathResolver.knowledge('product/governance/security-policy.json'), {
        encoding: 'utf8',
      }) as string
    );
    // DA-06: the public grant is the narrow knowledge/public/ingest/ subtree
    // (steward-approved landings only) — never knowledge/public/ wholesale.
    expect(policy.authority_role_permissions.ingest_commit).toEqual({
      allow_write: ['knowledge/confidential/', 'knowledge/public/ingest/'],
    });
  });

  it('knowledge/confidential/ writes are denied without the role and allowed under it', () => {
    delete process.env.KYBERION_PERSONA;
    process.env.MISSION_ROLE = 'unit_test_ingest_denied';
    const target = pathResolver.knowledge('confidential/acme-corp/reports/q1.md');
    expect(validateWritePermission(target).allowed).toBe(false);
    const underRole = withExecutionContext(INGEST_COMMIT_ROLE, () =>
      validateWritePermission(target)
    );
    expect(underRole.allowed).toBe(true);
    // The grant does not leak outside knowledge/confidential/.
    const outside = withExecutionContext(INGEST_COMMIT_ROLE, () =>
      validateWritePermission(pathResolver.knowledge('product/governance/anything.md'))
    );
    expect(outside.allowed).toBe(false);
  });
});

describe('ingest:commit ceremony + supersede E2E (DA-05 acceptance 3)', () => {
  const assetId = deriveAssetId('confluence', 'PAGE-1');

  async function ingestOnce(markdown: string, now: string) {
    const ir = await parseDocument({
      content_text: markdown,
      format: 'markdown',
      source_meta: {
        source_system: 'confluence',
        source_id: 'PAGE-1',
        retrieved_at: now,
      },
    });
    const normalized = normalizeCard({
      ir,
      target: { tenant_slug: 'acme-corp', relative_path: 'reports/q1.md' },
      card: { kind: 'reference' },
      now,
      path_options: options,
    });
    const dedup = dedupContent({
      content_sha256: ir.meta.content_sha256,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      registry_path: registryPath,
      target_path: normalized.target_path,
      now,
    });
    const result = commitIngest({
      tenant_slug: 'acme-corp',
      normalized,
      dedup_result: dedup,
      source_meta: { ...ir.meta },
      transform_chain: ['parse_document:markdown', 'normalize_card'],
      now,
      path_options: options,
    });
    return { ir, normalized, dedup, result };
  }

  it('fresh ingest lands the card and appends the version-1 ledger record', async () => {
    const { result } = await ingestOnce('# Ingest Commit Card\n\nVersion one body.', NOW);
    expect(result.committed).toBe(true);
    expect(result.asset).toMatchObject({
      asset_id: assetId,
      source_system: 'confluence',
      source_id: 'PAGE-1',
      version: 1,
      status: 'active',
      ingested_by: 'ecosystem_architect',
      visible_to: ['acme-corp'],
      transform_chain: ['parse_document:markdown', 'normalize_card'],
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    });
    expect(result.asset?.supersedes).toBeUndefined();
    expect(result.provenance_ref).toBe(`asset:${assetId}@v1`);
    const landed = path.join(fixtureRoot, 'knowledge/confidential/acme-corp/reports/q1.md');
    expect(safeExistsSync(landed)).toBe(true);
    expect(String(safeReadFile(landed, { encoding: 'utf8' }))).toContain('Version one body.');
  });

  it('exact re-ingest is a duplicate: no write, no new ledger record', async () => {
    const { result, dedup } = await ingestOnce('# Ingest Commit Card\n\nVersion one body.', NOW);
    expect(dedup.duplicate).toBe(true);
    expect(result).toMatchObject({ committed: false, reason: 'duplicate' });
    expect(readAssetLedger('acme-corp', options)).toHaveLength(1);
  });

  it('changed content for the same source becomes a SUPERSEDE: same target_path, version 2', async () => {
    const { result, dedup } = await ingestOnce(
      '# Ingest Commit Card\n\nVersion TWO body — source updated.',
      '2026-07-29T09:00:00.000Z'
    );
    // dedup saw the same source with a different hash.
    expect(dedup.duplicate).toBe(false);
    expect(dedup.supersedes_candidate).toBeDefined();
    expect(result.committed).toBe(true);
    expect(result.asset).toMatchObject({
      asset_id: assetId,
      version: 2,
      supersedes: `${assetId}@v1`,
      status: 'active',
      target_path: 'knowledge/confidential/acme-corp/reports/q1.md',
    });
    // The card was OVERWRITTEN at the same path, not landed as a new file.
    const landed = path.join(fixtureRoot, 'knowledge/confidential/acme-corp/reports/q1.md');
    expect(String(safeReadFile(landed, { encoding: 'utf8' }))).toContain('Version TWO body');
    // Lineage resolves: v1 superseded, v2 active.
    const lineage = assetLineage('acme-corp', assetId, options);
    expect(lineage.map((record) => record.status)).toEqual(['superseded', 'active']);
    // Dedup registry stayed consistent: one line per distinct content hash.
    const registryLines = String(safeReadFile(registryPath, { encoding: 'utf8' }))
      .split('\n')
      .filter(Boolean);
    expect(registryLines).toHaveLength(2);
    const hashes = registryLines.map((line) => JSON.parse(line).content_sha256);
    expect(new Set(hashes).size).toBe(2);
  });

  it('handleAction dispatches commit and staleness_report', async () => {
    const staleCtx = await handleAction({
      action: 'staleness_report',
      params: {
        tenant_slug: 'acme-corp',
        current_sources: [
          { source_system: 'confluence', source_id: 'PAGE-1', content_sha256: 'f'.repeat(64) },
        ],
        path_options: options,
      },
    });
    const report = staleCtx.staleness as {
      assets: unknown[];
      stale: Array<{ asset_id: string; version: number; reason: string }>;
    };
    expect(report.assets).toHaveLength(1);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({
      asset_id: assetId,
      version: 2,
      reason: 'content_hash_mismatch',
    });

    const card = normalizedCard('# Dispatch\n\nDispatch body.', 'reports/dispatch.md');
    const commitCtx = await handleAction({
      action: 'commit',
      params: {
        tenant_slug: 'acme-corp',
        normalized: card,
        source_meta: {
          source_system: 'confluence',
          source_id: 'PAGE-2',
          content_sha256: 'b'.repeat(64),
        },
        now: NOW,
        path_options: options,
      },
    });
    expect((commitCtx.commit as { committed: boolean }).committed).toBe(true);
  });
});
