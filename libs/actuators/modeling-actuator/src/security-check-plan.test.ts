import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { promoteSecurityLedger, recordCheckResults } from '@agent/core/security-asset-ledger';
import type { SecurityAssetEntry } from '@agent/core/security-asset-ledger';

import { securityLedgerCheckPlan } from './security-check-plan.js';

let fixtureRoot = '';
let options: { rootDir: string; env: NodeJS.ProcessEnv };

function entry(id: string, overrides: Partial<SecurityAssetEntry> = {}): SecurityAssetEntry {
  return {
    service_id: id,
    name: id,
    category: 'saas',
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
    discovery_sources: ['test'],
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
    `security-check-plan-${randomUUID()}`
  );
  options = { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv };
  const tenantsDir = `${fixtureRoot}/knowledge/personal/tenants`;
  safeMkdir(tenantsDir, { recursive: true });
  safeWriteFile(
    `${tenantsDir}/acme-corp.json`,
    JSON.stringify({
      tenant_slug: 'acme-corp',
      display_name: 'ACME Corp',
      status: 'active',
      assigned_role: 'owner',
    })
  );

  promoteSecurityLedger(
    'acme-corp',
    {
      entries: [
        entry('svc:saas-1', {
          category: 'saas',
          endpoints: ['https://app.example.com/health', 'api.example.com'],
          exposure: 'public',
        }),
        entry('asset:app-1', {
          category: 'published-app',
          endpoints: ['https://pub.example.com/'],
          exposure: 'public',
        }),
        entry('asset:db-1', { category: 'data-store', endpoints: [] }),
        entry('asset:ctrl-1', {
          category: 'network-control',
          endpoints: ['internal.example.com'],
        }),
      ],
    },
    { promotedBy: 'tester', ...options }
  );
});

afterAll(() => {
  safeRmSync(fixtureRoot);
});

describe('securityLedgerCheckPlan (Phase 3)', () => {
  it('emits one item per endpoint for checkable categories', () => {
    const plan = securityLedgerCheckPlan('acme-corp', options);
    expect(plan.kind).toBe('security_ledger_check_plan');
    expect(plan.check_id).toBe('A-1-reachability');
    expect(plan.items).toHaveLength(3);
    // saas + published-app included; network-control endpoint excluded by default.
    const ids = new Set(plan.items.map((i) => i.service_id));
    expect(ids.has('svc:saas-1')).toBe(true);
    expect(ids.has('asset:app-1')).toBe(true);
    expect(ids.has('asset:ctrl-1')).toBe(false);
    // Items carry exposure/category so the downstream check op can weight them.
    const saas = plan.items.find((i) => i.service_id === 'svc:saas-1')!;
    expect(saas.exposure).toBe('public');
    expect(plan.totals.services).toBe(2);
    expect(plan.totals.endpoints).toBe(3);
  });

  it('derives IPA obligations per category with done/missing status', () => {
    const plan = securityLedgerCheckPlan('acme-corp', options);
    // published-app public → A-1/A-2/A-3; saas → B-1/B-2/B-3; data-store → C-1;
    // network-control → B-2. Plus 'A-1-reachability' probe obligations for the
    // two endpoint-bearing services.
    const byService = (id: string) => plan.obligations.filter((o) => o.service_id === id);
    expect(
      byService('asset:app-1')
        .map((o) => o.check_id)
        .sort()
    ).toEqual(['A-1', 'A-1-reachability', 'A-2', 'A-3']);
    expect(byService('svc:saas-1').filter((o) => o.check_id === 'B-2')[0].kind).toBe('manual');
    expect(byService('asset:db-1').map((o) => o.check_id)).toEqual(['C-1']);
    // Endpoint-bearing network control: manual B-2 + the probe obligation.
    expect(
      byService('asset:ctrl-1')
        .map((o) => o.check_id)
        .sort()
    ).toEqual(['A-1-reachability', 'B-2']);
    // Everything is missing until recorded.
    expect(plan.totals.missing).toBe(plan.totals.obligations);
  });

  it('flips an obligation to done once the check result is recorded', () => {
    recordCheckResults(
      'acme-corp',
      [
        {
          service_id: 'asset:db-1',
          check: { check_id: 'C-1', result: 'manual-verified', evidence: 'data audit done' },
        },
      ],
      { promotedBy: 'tester', ...options }
    );
    const plan = securityLedgerCheckPlan('acme-corp', options);
    const c1 = plan.obligations.find((o) => o.service_id === 'asset:db-1' && o.check_id === 'C-1')!;
    expect(c1.status).toBe('done');
    expect(plan.totals.missing).toBe(plan.totals.obligations - 1);
  });

  it('honours a custom category filter', () => {
    const plan = securityLedgerCheckPlan('acme-corp', {
      includeCategories: ['network-control'],
      ...options,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].service_id).toBe('asset:ctrl-1');
  });

  it('emits an empty plan when the ledger is empty', () => {
    const empty = securityLedgerCheckPlan('acme-corp', {
      includeCategories: ['data-store'],
      ...options,
    });
    expect(empty.items).toEqual([]);
    expect(empty.totals.endpoints).toBe(0);
  });
});
