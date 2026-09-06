/**
 * DA-08 acceptance (3): クォータ超過が warn→block で表面化 — E2E through
 * commitIngest. Under the warn threshold the ceremony commits with
 * quota_level 'ok'; crossing the warn threshold logs + commits (warn is
 * advisory); exceeding a daily limit refuses the commit with a structured
 * error and writes NOTHING; usage is recorded only on successful commits
 * (refused and duplicate ceremonies consume no quota).
 *
 * Hermetic: tenant profile, ledger, landing root, quota policy and quota
 * counters all live under a fixture rootDir in active/shared/tmp (path
 * seams); enforcement is opted into via KYBERION_INGEST_QUOTA_TEST=1
 * (spend-guard VITEST convention — the pre-existing commit tests run with it
 * unset and never see the quota gate).
 */

import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INGEST_QUOTA_POLICY_REPO_PATH, ingestQuotaCounterPath } from '@agent/core/ingest-quota';
import { readAssetLedger } from '@agent/core/ingest-asset-ledger';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { commitIngest } from './commit.js';
import { normalizeCard, type NormalizeCardResult } from './normalize-card.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const NOW = '2026-07-28T09:00:00.000Z';
const ENV_KEYS = ['KYBERION_PERSONA', 'MISSION_ROLE', 'KYBERION_INGEST_QUOTA_TEST'] as const;

let fixtureRoot = '';
let options: { rootDir: string; env: NodeJS.ProcessEnv };
const savedEnv: Record<string, string | undefined> = {};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function card(sourceId: string, markdown: string): NormalizeCardResult {
  return normalizeCard({
    ir: {
      title: `Quota Card ${sourceId}`,
      text_markdown: markdown,
      meta: {
        source_system: 'confluence',
        source_id: sourceId,
        retrieved_at: '2026-07-20T00:00:00.000Z',
        format: 'markdown',
        content_sha256: sha256Hex(markdown),
        char_count: markdown.length,
      },
    },
    target: { tenant_slug: 'acme-corp', relative_path: `reports/${sourceId}.md` },
    card: { kind: 'reference' },
    now: NOW,
    path_options: options,
  });
}

function commitOnce(sourceId: string, markdown = `# Quota\n\nBody of ${sourceId}.`) {
  return commitIngest({
    tenant_slug: 'acme-corp',
    normalized: card(sourceId, markdown),
    now: NOW,
    path_options: options,
  });
}

function readCounter(): { files: number; bytes: number } | null {
  const counterPath = ingestQuotaCounterPath('acme-corp', { rootDir: fixtureRoot, now: NOW });
  if (!safeExistsSync(counterPath)) return null;
  return JSON.parse(String(safeReadFile(counterPath, { encoding: 'utf8' })));
}

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `ingest-commit-quota-da08-${randomUUID()}`
  );
  options = { rootDir: fixtureRoot, env: EMPTY_ENV };
  const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
  safeMkdir(tenantDir, { recursive: true });
  safeWriteFile(
    path.join(tenantDir, 'acme-corp.json'),
    JSON.stringify(
      { tenant_slug: 'acme-corp', display_name: 'acme', status: 'active', assigned_role: 'owner' },
      null,
      2
    )
  );
  // Tight governed limits so three small commits walk ok → warn → block.
  const policyPath = path.join(fixtureRoot, ...INGEST_QUOTA_POLICY_REPO_PATH.split('/'));
  safeMkdir(path.dirname(policyPath), { recursive: true });
  safeWriteFile(
    policyPath,
    JSON.stringify(
      {
        version: '1.0.0',
        max_files_per_day: 2,
        max_bytes_per_day: 1024 * 1024,
        warn_ratio: 0.9,
        tenant_overrides: {},
      },
      null,
      2
    )
  );
});

afterAll(() => {
  if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  process.env.KYBERION_INGEST_QUOTA_TEST = '1';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('ingest:commit quota gate (DA-08 acceptance 3)', () => {
  it('walks ok → warn → block across the daily file budget, recording usage only on success', () => {
    // 1st commit: projected 1/2 files, under warn_ratio 0.9×2 → ok.
    const first = commitOnce('PAGE-Q1');
    expect(first.committed).toBe(true);
    expect(first.quota_level).toBe('ok');
    expect(readCounter()).toMatchObject({ files: 1 });

    // 2nd commit: projected 2 >= 0.9×2 → warn, still commits (staged enforcement).
    const second = commitOnce('PAGE-Q2');
    expect(second.committed).toBe(true);
    expect(second.quota_level).toBe('warn');
    expect(readCounter()).toMatchObject({ files: 2 });
    expect(
      safeExistsSync(path.join(fixtureRoot, 'knowledge/confidential/acme-corp/reports/PAGE-Q2.md'))
    ).toBe(true);

    // 3rd commit: projected 3 > 2 → block. Structured error, nothing written,
    // no quota consumed.
    expect(() => commitOnce('PAGE-Q3')).toThrow(/blocked by the ingest quota \(files\)/);
    expect(
      safeExistsSync(path.join(fixtureRoot, 'knowledge/confidential/acme-corp/reports/PAGE-Q3.md'))
    ).toBe(false);
    expect(readAssetLedger('acme-corp', options)).toHaveLength(2);
    expect(readCounter()).toMatchObject({ files: 2 });

    // A duplicate re-ingest short-circuits BEFORE the quota gate: no error,
    // no write, no quota consumed.
    const duplicate = commitIngest({
      tenant_slug: 'acme-corp',
      normalized: card('PAGE-Q1', '# Quota\n\nBody of PAGE-Q1.'),
      dedup_result: { duplicate: true, registered: false },
      now: NOW,
      path_options: options,
    });
    expect(duplicate).toMatchObject({ committed: false, reason: 'duplicate' });
    expect(readCounter()).toMatchObject({ files: 2 });
  });

  it('stays inert for tests that do not opt in (spend-guard VITEST convention)', () => {
    delete process.env.KYBERION_INGEST_QUOTA_TEST;
    // Over the file budget from the previous test, but the gate is off: commits fine.
    const result = commitOnce('PAGE-Q4');
    expect(result.committed).toBe(true);
    expect(result.quota_level).toBeUndefined();
    // And no usage is recorded when enforcement is off.
    expect(readCounter()).toMatchObject({ files: 2 });
  });
});
