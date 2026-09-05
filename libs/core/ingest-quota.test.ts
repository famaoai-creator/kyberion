/**
 * DA-08 取込クォータ — hermetic unit tests for the per-tenant daily ingest
 * budget (warn→block staging, governed policy + tenant overrides, persisted
 * daily counters). Everything runs against a fixture rootDir under
 * active/shared/tmp via the module's own path seam — no mocking needed.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  checkIngestQuota,
  DEFAULT_INGEST_QUOTA_POLICY,
  INGEST_QUOTA_POLICY_REPO_PATH,
  ingestQuotaCounterPath,
  ingestQuotaDateKey,
  loadIngestQuotaPolicy,
  recordIngestUsage,
  resolveIngestQuotaForTenant,
  shouldEnforceIngestQuota,
} from './ingest-quota.js';

const NOW = '2026-07-28T09:00:00.000Z';

let fixtureRoot = '';

function writePolicy(policy: unknown): void {
  const policyPath = path.join(fixtureRoot, ...INGEST_QUOTA_POLICY_REPO_PATH.split('/'));
  safeMkdir(path.dirname(policyPath), { recursive: true });
  safeWriteFile(policyPath, typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2));
}

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `ingest-quota-da08-${randomUUID()}`
  );
  safeMkdir(fixtureRoot, { recursive: true });
});

afterAll(() => {
  if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('policy loading (spend-policy.json override pattern)', () => {
  it('fails closed when no policy file exists', () => {
    const missingRoot = path.join(fixtureRoot, 'no-policy-here');
    expect(() => loadIngestQuotaPolicy({ rootDir: missingRoot })).toThrowError(/missing/iu);
  });

  it('fails closed on a corrupt policy file', () => {
    writePolicy('{not json!!');
    expect(() => loadIngestQuotaPolicy({ rootDir: fixtureRoot })).toThrowError(
      /Expected property name|JSON/iu
    );
  });

  it('loads governed limits and per-tenant overrides keyed by tenant slug', () => {
    writePolicy({
      version: '1.0.0',
      max_files_per_day: 10,
      max_bytes_per_day: 1000,
      warn_ratio: 0.5,
      tenant_overrides: {
        'acme-corp': { max_files_per_day: 3 },
        'bad-entry': { max_files_per_day: -1 },
      },
    });
    const policy = loadIngestQuotaPolicy({ rootDir: fixtureRoot });
    expect(policy).toMatchObject({
      max_files_per_day: 10,
      max_bytes_per_day: 1000,
      warn_ratio: 0.5,
    });
    expect(policy.tenant_overrides).toEqual({ 'acme-corp': { max_files_per_day: 3 } });

    // Override applies only to the named tenant (spend-guard pattern).
    expect(resolveIngestQuotaForTenant(policy, 'acme-corp')).toEqual({
      limits: { max_files_per_day: 3, max_bytes_per_day: 1000 },
      warn_ratio: 0.5,
    });
    expect(resolveIngestQuotaForTenant(policy, 'other-co')).toEqual({
      limits: { max_files_per_day: 10, max_bytes_per_day: 1000 },
      warn_ratio: 0.5,
    });
  });

  it('the committed governance policy file parses to sane values', () => {
    const committed = loadIngestQuotaPolicy({ rootDir: pathResolver.rootDir() });
    expect(committed.max_files_per_day).toBeGreaterThan(0);
    expect(committed.max_bytes_per_day).toBeGreaterThan(0);
    expect(committed.warn_ratio).toBeGreaterThan(0);
    expect(committed.warn_ratio).toBeLessThanOrEqual(1);
  });
});

describe('checkIngestQuota — warn→block staging', () => {
  const policy = {
    max_files_per_day: 4,
    max_bytes_per_day: 1000,
    warn_ratio: 0.5,
  };

  it('ok under the warn threshold, warn at the threshold, block over the limit', () => {
    const rootDir = path.join(fixtureRoot, `staging-${randomUUID()}`);
    const options = { rootDir, now: NOW, policy };

    // Fresh day: projected files 1 < 0.5×4 → ok.
    const first = checkIngestQuota('acme-corp', { bytes: 100 }, options);
    expect(first).toMatchObject({
      allowed: true,
      level: 'ok',
      date: '2026-07-28',
      usage: { files: 0, bytes: 0 },
      projected: { files: 1, bytes: 100 },
      exceeded: [],
      warned: [],
    });

    // checkIngestQuota records NOTHING — the caller records after success.
    expect(safeExistsSync(ingestQuotaCounterPath('acme-corp', options))).toBe(false);

    recordIngestUsage('acme-corp', 100, 1, options);
    // Projected files 2 >= 0.5×4 → warn, still allowed.
    const second = checkIngestQuota('acme-corp', { bytes: 100 }, options);
    expect(second).toMatchObject({ allowed: true, level: 'warn', warned: ['files'] });

    recordIngestUsage('acme-corp', 100, 1, options);
    recordIngestUsage('acme-corp', 100, 1, options);
    recordIngestUsage('acme-corp', 100, 1, options);
    // Projected files 5 > 4 → block, refused.
    const blocked = checkIngestQuota('acme-corp', { bytes: 100 }, options);
    expect(blocked).toMatchObject({
      allowed: false,
      level: 'block',
      usage: { files: 4, bytes: 400 },
      projected: { files: 5, bytes: 500 },
      exceeded: ['files'],
    });
  });

  it('blocks on the bytes dimension independently of files', () => {
    const rootDir = path.join(fixtureRoot, `bytes-${randomUUID()}`);
    const options = { rootDir, now: NOW, policy };
    const blocked = checkIngestQuota('acme-corp', { bytes: 1001 }, options);
    expect(blocked).toMatchObject({ allowed: false, level: 'block', exceeded: ['bytes'] });
    // A small ingest on the same fresh day is still fine.
    expect(checkIngestQuota('acme-corp', { bytes: 10 }, options).level).toBe('ok');
  });

  it('counters are per tenant × per UTC day', () => {
    const rootDir = path.join(fixtureRoot, `days-${randomUUID()}`);
    const options = { rootDir, now: NOW, policy };
    recordIngestUsage('acme-corp', 900, 3, options);
    expect(checkIngestQuota('acme-corp', { bytes: 200 }, options).level).toBe('block');
    // Another tenant: unaffected.
    expect(checkIngestQuota('other-co', { bytes: 200 }, options).level).toBe('ok');
    // Next day: the budget resets.
    const tomorrow = { ...options, now: '2026-07-29T09:00:00.000Z' };
    expect(checkIngestQuota('acme-corp', { bytes: 200 }, tomorrow).level).toBe('ok');
    expect(ingestQuotaDateKey(tomorrow.now)).toBe('2026-07-29');
  });

  it('persists counters at active/shared/runtime/ingest/quota/{tenant}/{date}.json', () => {
    const rootDir = path.join(fixtureRoot, `path-${randomUUID()}`);
    const options = { rootDir, now: NOW, policy };
    recordIngestUsage('acme-corp', 42, 1, options);
    const counterPath = ingestQuotaCounterPath('acme-corp', options);
    expect(counterPath).toBe(
      path.join(
        rootDir,
        'active',
        'shared',
        'runtime',
        'ingest',
        'quota',
        'acme-corp',
        '2026-07-28.json'
      )
    );
    expect(JSON.parse(String(safeReadFile(counterPath, { encoding: 'utf8' })))).toMatchObject({
      tenant_slug: 'acme-corp',
      date: '2026-07-28',
      files: 1,
      bytes: 42,
    });
  });

  it('does not adopt schema-invalid, cross-tenant, or non-file counters', () => {
    const rootDir = path.join(fixtureRoot, `boundary-${randomUUID()}`);
    const options = { rootDir, now: NOW, policy: { ...policy } };
    const counterPath = ingestQuotaCounterPath('acme-corp', options);
    safeMkdir(path.dirname(counterPath), { recursive: true });
    const updatedAt = new Date(NOW).toISOString();

    safeWriteFile(
      counterPath,
      JSON.stringify({
        tenant_slug: 'acme-corp',
        date: '2026-07-28',
        files: 4,
        bytes: 900,
        updated_at: updatedAt,
        unexpected: true,
      })
    );
    expect(checkIngestQuota('acme-corp', { bytes: 1 }, options).usage).toEqual({
      files: 0,
      bytes: 0,
    });

    safeWriteFile(
      counterPath,
      JSON.stringify({
        tenant_slug: 'other-co',
        date: '2026-07-28',
        files: 4,
        bytes: 900,
        updated_at: updatedAt,
      })
    );
    expect(checkIngestQuota('acme-corp', { bytes: 1 }, options).usage).toEqual({
      files: 0,
      bytes: 0,
    });

    safeRmSync(counterPath, { force: true });
    safeMkdir(counterPath, { recursive: true });
    expect(checkIngestQuota('acme-corp', { bytes: 1 }, options).usage).toEqual({
      files: 0,
      bytes: 0,
    });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('rejects invalid tenant slugs (path safety)', () => {
    expect(() => checkIngestQuota('../escape', { bytes: 1 }, { rootDir: fixtureRoot })).toThrow(
      /invalid tenant slug/
    );
    expect(() => recordIngestUsage('UPPER', 1, 1, { rootDir: fixtureRoot })).toThrow(
      /invalid tenant slug/
    );
  });

  it('rejects a quota root outside the repository', () => {
    expect(() => ingestQuotaCounterPath('acme-corp', { rootDir: '/tmp' })).toThrow(
      /outside the repository/
    );
  });
});

describe('shouldEnforceIngestQuota — spend-guard VITEST convention', () => {
  it('routes the opt-in flag through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/ingest-quota.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('is off under VITEST unless the test opts in, on otherwise', () => {
    expect(shouldEnforceIngestQuota({ VITEST: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      shouldEnforceIngestQuota({
        VITEST: 'true',
        KYBERION_INGEST_QUOTA_TEST: '1',
      } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(shouldEnforceIngestQuota({} as NodeJS.ProcessEnv)).toBe(true);
  });
});
