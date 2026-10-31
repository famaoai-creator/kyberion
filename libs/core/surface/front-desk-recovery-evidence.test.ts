import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-action-ledger.js';
import type {
  FrontDeskExecutionBinding,
  FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp/recovery-evidence-' + crypto.randomUUID());
const tenant = 'recovery-evidence';
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let evidence: typeof import('./front-desk-recovery-evidence.js');
let records: typeof import('../dot/dot-result-records.js');
let file: string;
const scope = { tier: 'confidential' as const, tenant_slug: tenant };
const charter = {
  kind: 'dot-charter',
  dot_id: 'recovery-dot',
  version: '1.0.0',
  title: 'Fixture',
  purpose: 'Absence proof regression',
  status: 'active',
  scope,
  goal: { statement: 'Synthetic fixture' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
} as DotCharter;
const binding: FrontDeskExecutionBinding = {
  mapping_id: 'fixture',
  config_digest: 'a'.repeat(64),
  conversation_key: 'b'.repeat(64),
  request_id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  request_digest: 'c'.repeat(64),
  work_item_id: 'WI-FD-' + 'd'.repeat(48),
};
const mapping: FrontDeskExecutionMapping = {
  id: 'fixture',
  dotId: charter.dot_id,
  viewer: {
    principalId: 'human:fixture',
    memberId: 'fixture',
    role: 'localadmin',
    source: 'token',
    tenantSlugs: [tenant],
    organizationIds: [],
    projectIds: [],
    tierAccess: ['public'],
  },
  exactCommand: 'Create a local diagnostic request receipt artifact.',
  pipeline: { path: 'pipelines/front-desk-request-receipt.json', version: 'receipt-v1' },
};
const action = {
  dot_id: charter.dot_id,
  action_ref: 'retained-action',
  work_item_id: binding.work_item_id,
  status: 'parked',
  at: '2026-10-31T00:00:00.000Z',
} as DotActionRecord;
const row = {
  dot_id: charter.dot_id,
  work_item_id: binding.work_item_id,
  action_ref: action.action_ref,
  attempt_id: 'retained-attempt',
  mode: 'pipeline' as const,
  status: 'failed' as const,
  summary: 'Synthetic ambiguous retained result',
  started_at: '2026-10-31T00:00:00.000Z',
  completed_at: '2026-10-31T00:00:00.000Z',
  report_to_dot_id: 'operator',
};
const operator = <T>(fn: () => T) =>
  authority.withExecutionContext('ecosystem_architect', fn, undefined, tenant);
const put = (rows: unknown[]) =>
  operator(() =>
    io.safeWriteFile(
      file,
      rows.map((value) => JSON.stringify(value)).join('\n') + (rows.length ? '\n' : '')
    )
  );
const absent = () =>
  operator(() => evidence.assertFrontDeskRecoveryOutputsAbsent(charter, binding, action, mapping));
beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  const copy = (relative: string): void => {
    const source = path.join(sourceRoot, relative),
      target = path.join(root, relative);
    if (bootstrap.safeLstat(source).isDirectory()) {
      bootstrap.safeMkdir(target, { recursive: true });
      for (const entry of bootstrap.safeReaddir(source)) copy(path.join(relative, entry));
    } else bootstrap.safeCopyFileSync(source, target);
  };
  for (const directory of ['knowledge/product/schemas', 'knowledge/product/governance'])
    copy(directory);
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  bootstrap.safeMkdir(path.join(root, 'active/shared/runtime/dot/confidential', tenant), {
    recursive: true,
  });
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  evidence = await import('./front-desk-recovery-evidence.js');
  records = await import('../dot/dot-result-records.js');
  const { dotStatePath, DOT_WORK_RESULTS_FILE } = await import('../dot/dot-state-paths.js');
  file = path.join(root, dotStatePath(charter, DOT_WORK_RESULTS_FILE));
}, 60000);
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrap.safeRmSync(root, { recursive: true, force: true });
});
describe('strict retained output proof with actual confidential ledger and source identities', () => {
  it('accepts empty evidence but rejects a linked original plus a valid same-scope marker by output linkage', () => {
    put([]);
    expect(absent).not.toThrow();
    const marker = records.createDotReportMarker({
      row,
      scope,
      reportTo: 'operator',
      enqueuedAt: row.completed_at,
    });
    for (const rows of [[row], [row, marker]]) {
      put(rows);
      expect(absent).toThrow('incomplete_recovery_output_evidence');
    }
  });
  it('refuses orphan and unknown markers instead of proving absence', () => {
    const marker = records.createDotReportMarker({
      row,
      scope,
      reportTo: 'operator',
      enqueuedAt: row.completed_at,
    });
    for (const rows of [[marker], [{ ...marker, kind: 'unknown-marker' }]]) {
      put(rows);
      expect(absent).toThrow();
    }
  });
});
