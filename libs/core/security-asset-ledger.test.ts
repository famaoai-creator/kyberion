import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { nowIso } from './foundation/time.js';
import {
  checkStatusFor,
  findServiceRecord,
  listSecurityAssets,
  promoteSecurityLedger,
  recordCheckResults,
  requiredChecksFor,
  retireSecurityAsset,
  serviceLineage,
  type SecurityAssetEntry,
} from './security-asset-ledger.js';

let fixtureRoot = '';
let options: { rootDir: string; env: NodeJS.ProcessEnv };

function entry(id: string, overrides: Partial<SecurityAssetEntry> = {}): SecurityAssetEntry {
  return {
    service_id: id,
    name: id,
    category: 'published-app',
    endpoints: [],
    exposure: 'unknown',
    data_classification: 'unknown',
    auth_method: 'unknown',
    mfa_status: 'unknown',
    log_access: 'unknown',
    account_admin: 'unknown',
    owner: 'unknown',
    department: 'unknown',
    contract_ref: 'none',
    discovery_sources: ['S-8'],
    last_verified: 'unverified',
    shadow: true,
    review_status: 'pending',
    ...overrides,
  };
}

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `security-ledger-${randomUUID()}`
  );
  options = { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv };
  const tenantDir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
  safeMkdir(tenantDir, { recursive: true });
  safeWriteFile(
    path.join(tenantDir, 'acme-corp.json'),
    JSON.stringify(
      {
        tenant_slug: 'acme-corp',
        display_name: 'acme-corp',
        status: 'active',
        assigned_role: 'owner',
      },
      null,
      2
    )
  );
});

afterAll(() => {
  safeRmSync(fixtureRoot);
});

const OPTS = { promotedBy: 'tester' };

describe('security-asset-ledger', () => {
  it('promotes a draft into an append-only tenant ledger', () => {
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws'), entry('asset:app-1')] },
      { ...OPTS, ...options }
    );
    expect(result.committed).toBe(true);
    expect(result.added.sort()).toEqual(['asset:app-1', 'svc:aws']);
    const assets = listSecurityAssets('acme-corp', options);
    expect(assets).toHaveLength(2);
    expect(assets[0].version).toBe(1);
    expect(assets[0].status).toBe('active');
    // Ledger lands inside the tenant security dir.
    expect(assets[0].asset_id.startsWith('sec-')).toBe(true);
  });

  it('re-promotion carries governance forward and never rewrites history', () => {
    // Human verified the entry between promotions (simulated by verify flag).
    promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws'), entry('asset:app-1'), entry('asset:app-2')] },
      { ...OPTS, ...options, verifyIds: ['svc:aws'], asOf: '2026-10-12' }
    );
    const aws = findServiceRecord('acme-corp', 'svc:aws', options)!;
    expect(aws.version).toBe(2);
    expect(aws.entry.review_status).toBe('verified');
    expect(aws.entry.last_verified).toBe('2026-10-12');
    // Lineage preserves the pending v1.
    const chain = serviceLineage('acme-corp', 'svc:aws', options);
    expect(chain.map((r) => r.version)).toEqual([1, 2]);
    expect(chain[0].status).toBe('superseded');
    expect(chain[0].entry.review_status).toBe('pending');
    // Second promotion of an identical draft = unchanged.
    const again = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws'), entry('asset:app-1'), entry('asset:app-2')] },
      { ...OPTS, ...options }
    );
    expect(again.unchanged).toContain('svc:aws');
    expect(findServiceRecord('acme-corp', 'svc:aws', options)!.version).toBe(2);
  });

  it('reports not_observed entries without auto-retiring them', () => {
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws')] },
      { ...OPTS, ...options }
    );
    expect(result.not_observed.sort()).toEqual(['asset:app-1', 'asset:app-2']);
    // The unobserved entries are still active — logical deletion is explicit.
    expect(findServiceRecord('acme-corp', 'asset:app-1', options)!.status).toBe('active');
  });

  it('retire is an explicit ceremony; re-promotion continues the version chain', () => {
    const record = retireSecurityAsset('acme-corp', 'asset:app-2', { ...OPTS, ...options });
    expect(record.status).toBe('retired');
    const head = findServiceRecord('acme-corp', 'asset:app-2', options)!;
    expect(head.status).toBe('retired');
    const priorVersion = head.version;
    // Re-activation continues the same asset's version chain — same logical
    // service, never a forked v1.
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('asset:app-2')] },
      { ...OPTS, ...options }
    );
    expect(result.added).toEqual(['asset:app-2']);
    const reactivated = findServiceRecord('acme-corp', 'asset:app-2', options)!;
    expect(reactivated.version).toBe(priorVersion + 1);
    expect(reactivated.status).toBe('active');
    expect(reactivated.entry.review_status).toBe('pending');
    const versions = serviceLineage('acme-corp', 'asset:app-2', options).map((r) => r.version);
    expect(versions).toEqual([...Array(priorVersion + 1).keys()].map((n) => n + 1));
  });

  it('dry-run computes the full merge without appending anything', () => {
    const before = listSecurityAssets('acme-corp', options).length;
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws', { exposure: 'internal-only' }), entry('asset:new-1')] },
      { ...OPTS, ...options, dryRun: true }
    );
    expect(result.committed).toBe(false);
    expect(result.dry_run).toBe(true);
    expect(result.updated).toContain('svc:aws'); // exposure changed
    expect(result.added).toEqual(['asset:new-1']);
    // Nothing was appended.
    expect(listSecurityAssets('acme-corp', options).length).toBe(before);
  });

  it('governance overrides apply as the human correction path', () => {
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws')] },
      { ...OPTS, ...options, overrides: { owner: 'platform-team', contract_ref: 'PO-123' } }
    );
    expect(result.updated).toEqual(['svc:aws']);
    const aws = findServiceRecord('acme-corp', 'svc:aws', options)!;
    expect(aws.entry.owner).toBe('platform-team');
    expect(aws.entry.contract_ref).toBe('PO-123');
    // Governance values + contract → shadow clears.
    expect(aws.entry.shadow).toBe(false);
    // review_status stays verified from the earlier --verify promotion.
    expect(aws.entry.review_status).toBe('verified');
  });

  it('reports duplicate service_ids in the draft instead of silently merging', () => {
    const result = promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('svc:aws'), entry('svc:aws', { name: 'dup' })] },
      { ...OPTS, ...options }
    );
    expect(result.duplicate_draft_ids).toEqual(['svc:aws']);
  });

  it('clears shadow on brand-new entries when overrides supply governance', () => {
    promoteSecurityLedger(
      'acme-corp',
      { entries: [entry('asset:fresh-1')] },
      { ...OPTS, ...options, overrides: { owner: 'platform-team', contract_ref: 'PO-9' } }
    );
    const rec = findServiceRecord('acme-corp', 'asset:fresh-1', options)!;
    expect(rec.entry.shadow).toBe(false);
  });

  it('recordCheckResults appends one version per service and keeps latest per check_id', () => {
    const priorVersion = findServiceRecord('acme-corp', 'svc:aws', options)!.version;
    const result = recordCheckResults(
      'acme-corp',
      [
        {
          service_id: 'svc:aws',
          check: {
            check_id: 'A-1-reachability',
            result: 'reachable',
            evidence: 'HTTP 200',
            checked_at: '2026-10-12T00:00:00Z',
          },
        },
        {
          service_id: 'svc:aws',
          check: {
            check_id: 'B-3',
            result: 'manual-verified',
            evidence: 'account audit done',
            checked_at: '2026-10-12T00:00:00Z',
          },
        },
        {
          service_id: 'svc:unknown-x',
          check: { check_id: 'A-1-reachability', result: 'unreachable' },
        },
      ],
      { ...OPTS, ...options }
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toEqual({ service_id: 'svc:aws', version: priorVersion + 1 });
    expect(result.unknown_services).toEqual(['svc:unknown-x']);
    const aws = findServiceRecord('acme-corp', 'svc:aws', options)!;
    expect(aws.entry.check_results?.map((c) => c.check_id).sort()).toEqual([
      'A-1-reachability',
      'B-3',
    ]);
    // A second run updates the same check_id in place (latest wins).
    recordCheckResults(
      'acme-corp',
      [
        {
          service_id: 'svc:aws',
          check: {
            check_id: 'A-1-reachability',
            result: 'unreachable',
            evidence: 'timeout',
            checked_at: '2026-10-12T01:00:00Z',
          },
        },
      ],
      { ...OPTS, ...options }
    );
    const aws2 = findServiceRecord('acme-corp', 'svc:aws', options)!;
    const a1 = aws2.entry.check_results!.find((c) => c.check_id === 'A-1-reachability')!;
    expect(a1.result).toBe('unreachable');
    // The earlier outcome survives in the version chain.
    const lineage = serviceLineage('acme-corp', 'svc:aws', options);
    expect(
      lineage.some((r) =>
        r.entry.check_results?.some(
          (c) => c.check_id === 'A-1-reachability' && c.result === 'reachable'
        )
      )
    ).toBe(true);
  });

  it('byte-identical checks re-application is a no-op; a fresher timestamp refreshes', () => {
    const fixed = [
      {
        service_id: 'asset:app-1',
        check: {
          check_id: 'A-1',
          result: 'ok',
          evidence: 'registered',
          checked_at: '2026-10-12T00:00:00Z',
        },
      },
    ];
    const first = recordCheckResults('acme-corp', fixed, { ...OPTS, ...options });
    expect(first.applied).toHaveLength(1);
    // Same file re-applied → unchanged, no new version.
    const second = recordCheckResults('acme-corp', fixed, { ...OPTS, ...options });
    expect(second.applied).toEqual([]);
    expect(second.unchanged).toEqual(['asset:app-1']);
    expect(second.committed).toBe(false);
    // Same outcome with a newer checked_at → freshness refresh appends.
    const fresher = [
      {
        service_id: 'asset:app-1',
        check: {
          check_id: 'A-1',
          result: 'ok',
          evidence: 'registered',
          checked_at: '2026-10-13T00:00:00Z',
        },
      },
    ];
    const third = recordCheckResults('acme-corp', fresher, { ...OPTS, ...options });
    expect(third.applied).toHaveLength(1);
    const head = findServiceRecord('acme-corp', 'asset:app-1', options)!;
    expect(head.entry.check_results!.find((c) => c.check_id === 'A-1')!.checked_at).toBe(
      '2026-10-13T00:00:00Z'
    );
  });

  it('an older checks file never regresses a fresher recorded outcome', () => {
    // Head carries a fresh B-2 outcome; a replayed OLDER file must not roll it back.
    recordCheckResults(
      'acme-corp',
      [
        {
          service_id: 'svc:aws',
          check: {
            check_id: 'B-2',
            result: 'ok',
            evidence: 'logs reviewed',
            checked_at: '2026-10-12T00:00:00Z',
          },
        },
      ],
      { ...OPTS, ...options }
    );
    const staleReplay = recordCheckResults(
      'acme-corp',
      [
        {
          service_id: 'svc:aws',
          check: {
            check_id: 'B-2',
            result: 'finding',
            evidence: 'old anomaly',
            checked_at: '2026-08-01T00:00:00Z',
          },
        },
      ],
      { ...OPTS, ...options }
    );
    // Older checked_at loses the merge — the stale outcome is dropped, nothing
    // changes, so nothing is appended.
    expect(staleReplay.applied).toEqual([]);
    expect(staleReplay.unchanged).toEqual(['svc:aws']);
    const head = findServiceRecord('acme-corp', 'svc:aws', options)!;
    const b2 = head.entry.check_results!.find((c) => c.check_id === 'B-2')!;
    expect(b2.result).toBe('ok');
    expect(b2.checked_at).toBe('2026-10-12T00:00:00Z');
  });

  it('future-dated and undated checks are stale, not done', () => {
    const future = checkStatusFor({
      check_id: 'A-1',
      result: 'ok',
      checked_at: '2999-01-01T00:00:00Z',
    });
    const undated = checkStatusFor({ check_id: 'A-1', result: 'ok' });
    const fresh = checkStatusFor({ check_id: 'A-1', result: 'ok', checked_at: nowIso() });
    const missing = checkStatusFor(undefined);
    expect(future).toBe('stale');
    expect(undated).toBe('stale');
    expect(fresh).toBe('done');
    expect(missing).toBe('missing');
  });

  it('public data-store obligations include A-2 log review', () => {
    const entry2 = {
      ...entry('asset:db-pub', { category: 'data-store', exposure: 'public' }),
      service_id: 'asset:db-pub',
    };
    expect(requiredChecksFor(entry2).sort()).toEqual(['A-2', 'C-1']);
    expect(
      requiredChecksFor(
        entry('asset:db-pvt', { category: 'data-store', exposure: 'internal-only' })
      )
    ).toEqual(['C-1']);
  });

  it('refuses to append into a non-registry tenant', () => {
    expect(() =>
      promoteSecurityLedger(
        'no-such-tenant',
        { entries: [entry('svc:x')] },
        { ...OPTS, ...options }
      )
    ).toThrow();
  });
});
