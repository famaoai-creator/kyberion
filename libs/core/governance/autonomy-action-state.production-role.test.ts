import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the retention audit out of the shared audit log during tests.
const retentionAudits = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../storage-retention-expiry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage-retention-expiry.js')>();
  return {
    ...actual,
    appendRetentionAudit: (record: Record<string, unknown>) => retentionAudits.push(record),
  };
});

import { resolveRole, withExecutionContext } from '../authority.js';
import { safeReaddir, safeWriteFile, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { validateWritePermission } from '../tier-guard.js';
import { streamJsonLines } from '../jsonl-read.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import { autonomyLearningCapability } from '../foundation/autonomy-learning-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import {
  AUTONOMY_OUTCOMES_MIN_RETENTION_MS,
  AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS,
  setAutonomyOutcomesStoreTuningForTests,
  listAutonomyActionIds,
  type AutonomyOutcomeRow,
  actionAutonomyStats,
  recordAutonomyExecution,
  recordAutonomyOutcome,
  sweepAutonomyActionStates,
  applyAutonomyOverride,
} from './autonomy-action-state.js';

describe('production tenant autonomy store role mediation', () => {
  let tenantSlug: string;
  beforeEach(() => {
    tenantSlug = `vitest-learning-${randomUUID().slice(0, 8)}`;
    // Exercise real permission floors, not the deliberately writable Vitest sandbox.
    vi.stubEnv('VITEST', '');
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeWriteFile(
          pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`),
          JSON.stringify({ tenant_slug: tenantSlug, status: 'active' })
        ),
      'ecosystem_architect'
    );
  });
  afterEach(() => {
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeRmSync(
          pathResolver.rootResolve(
            `active/shared/runtime/autonomy-learning/confidential/${tenantSlug}`
          ),
          { recursive: true, force: true }
        ),
      'ecosystem_architect',
      tenantSlug
    );
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeRmSync(pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`), {
          force: true,
        }),
      'ecosystem_architect'
    );
    vi.unstubAllEnvs();
  });
  it.each(['mission_controller', 'organization_operator', 'chronos_gateway'])(
    'persists actual tenant receipts under %s without elevating callbacks or caller',
    (role) => {
      const action = `role-proof-${randomUUID()}`;
      withExecutionContext(
        role,
        () => {
          const deps = {
            tenantSlug,
            now: () => {
              expect(resolveRole()).toBe(role);
              return new Date();
            },
          };
          for (let i = 0; i < 20; i++) {
            const receipt_id = `${action}:${i}`;
            recordAutonomyOutcome(
              { action_id: action, receipt_id, decision: 'approve', executed: false },
              deps
            );
            recordAutonomyExecution({ action_id: action, receipt_id, ok: true }, deps);
          }
          expect(actionAutonomyStats(action, deps).succeeded).toBe(20);
          expect(sweepAutonomyActionStates([action], deps).promoted).toContain(`${action}→auto`);
          expect(applyAutonomyOverride(action, 'approve', [], deps).decision).toBe('auto');
          expect(resolveRole()).toBe(role);
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/unrelated.json`),
              '{}'
            )
          ).toThrow();
        },
        'worker',
        tenantSlug
      );
    }
  );

  it('refuses cross-tenant writes and keeps alternate-root IO under the caller', () => {
    withExecutionContext(
      'organization_operator',
      () => {
        expect(() =>
          recordAutonomyExecution(
            { action_id: 'never', receipt_id: randomUUID(), ok: true },
            { tenantSlug: 'other-tenant' }
          )
        ).toThrow('ROLE_TENANT_SCOPE_MISMATCH');
        expect(() =>
          recordAutonomyExecution(
            { action_id: 'never', receipt_id: randomUUID(), ok: true },
            {
              tenantSlug,
              rootDir: pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}`),
            }
          )
        ).toThrow();
      },
      'worker',
      tenantSlug
    );
  });

  it('the bounded role cannot mutate arbitrary tenant knowledge or another tenant', () => {
    expect(() =>
      withExecutionContext('autonomy_learning_store', () => undefined, 'worker', tenantSlug)
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    runInResourceAccessScope(autonomyLearningCapability(tenantSlug), () =>
      withExecutionContext(
        'autonomy_learning_store',
        () => {
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/unrelated.json`),
              '{}'
            )
          ).toThrow();
          expect(() =>
            safeWriteFile(
              pathResolver.shared(
                'runtime/autonomy-learning/confidential/other-tenant/autonomy-outcomes.jsonl'
              ),
              '{}'
            )
          ).toThrow();
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(
                `knowledge/confidential/${tenantSlug}/autonomy-outcomes.jsonl`
              ),
              '{}'
            )
          ).toThrow('RESOURCE_SCOPE_DENIED');
        },
        'worker',
        tenantSlug
      )
    );
    expect(() =>
      runInResourceAccessScope(
        {
          tenantSlug,
          readExact: [`knowledge/confidential/${tenantSlug}/unrelated.json`],
          writeExact: [`knowledge/confidential/${tenantSlug}/unrelated.json`],
          mkdirExact: [],
        },
        () => withExecutionContext('autonomy_learning_store', () => undefined, 'worker', tenantSlug)
      )
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    vi.stubEnv('SYSTEM_ROLE', 'autonomy_learning_store');
    expect(() =>
      safeWriteFile(
        pathResolver.shared(
          `runtime/autonomy-learning/confidential/${tenantSlug}/autonomy-outcomes.jsonl`
        ),
        '{}'
      )
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    vi.unstubAllEnvs();
    vi.stubEnv('VITEST', '');
  });

  describe('write-time retention of the tenant partition', () => {
    const partition = () => `active/shared/runtime/autonomy-learning/confidential/${tenantSlug}`;
    const asStore = <T>(fn: () => T): T =>
      runInResourceAccessScope(autonomyLearningCapability(tenantSlug), () =>
        withExecutionContext('autonomy_learning_store', fn, 'worker', tenantSlug)
      );
    const asOperator = <T>(fn: () => T): T =>
      withExecutionContext('ecosystem_architect', fn, 'ecosystem_architect', tenantSlug);

    beforeEach(() => {
      retentionAudits.length = 0;
      resetAppendOnlyStoreMaintenanceState();
    });
    afterEach(() => {
      setAutonomyOutcomesStoreTuningForTests({});
      resetAppendOnlyStoreMaintenanceState();
    });

    it('admits only this store’s rewrite siblings and its own archive', () => {
      const dir = partition();
      const store = `${dir}/autonomy-outcomes.jsonl`;
      const verdict = (rel: string, op: 'write' | 'append' | 'mkdir' = 'write') =>
        asStore(() => validateWritePermission(pathResolver.rootResolve(rel), op));
      for (const rel of [
        `${store}.compacting-t000001793491200000-000000-4242-initial`,
        `${store}.compacting-t000001793491200000-000001-4242-merge-0-1`,
        `${store}.compact-out-4242-0.tmp`,
        `${store}.compact-restore-4242-1.tmp`,
        `${dir}/compaction-archive/autonomy-outcomes.20261101T000000Z-4242.jsonl`,
      ]) {
        expect(verdict(rel), rel).toMatchObject({ allowed: true });
        expect(verdict(rel, 'append'), rel).toMatchObject({ allowed: true });
      }
      expect(verdict(`${dir}/compaction-archive`, 'mkdir')).toMatchObject({ allowed: true });

      for (const [rel, op] of [
        // another tenant's partition
        [
          `active/shared/runtime/autonomy-learning/confidential/other-tenant/autonomy-outcomes.jsonl.compacting-t1`,
          'write',
        ],
        [
          `active/shared/runtime/autonomy-learning/confidential/other-tenant/compaction-archive/a.jsonl`,
          'write',
        ],
        // a sibling in the same partition that is not this store's staging
        [`${dir}/notes.jsonl`, 'write'],
        [`${dir}/autonomy-outcomes.jsonl.bak`, 'write'],
        [`${dir}/compaction-archive/nested/a.jsonl`, 'write'],
        [`${dir}/compaction-archive/nested`, 'mkdir'],
        // the shared ledger's archive
        [`active/shared/observability/compaction-archive/autonomy-outcomes.x.jsonl`, 'write'],
        // path traversal out of the archive
        [`${dir}/compaction-archive/../../other-tenant/autonomy-outcomes.jsonl`, 'write'],
        [`${dir}/compaction-archive/../notes.jsonl`, 'write'],
        // a staging name of a different store
        [`${dir}/autonomy-action-overrides.json.compacting-t1`, 'write'],
        [`${dir}/autonomy-action-overrides.json.compact-out-1-0.tmp`, 'write'],
      ] as const) {
        expect(verdict(rel, op), rel).toMatchObject({ allowed: false });
      }
    });

    it('trims an oversized partition, archiving dropped rows in the tenant’s own archive', () => {
      setAutonomyOutcomesStoreTuningForTests({ minBytes: 2 * 1024, chunkBytes: 97 });
      const DAY_MS = 24 * 60 * 60 * 1000;
      const NOW = new Date();
      const old = new Date(
        NOW.getTime() -
          AUTONOMY_OUTCOMES_MIN_RETENTION_MS -
          AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS -
          3 * DAY_MS
      );
      const fresh = new Date(NOW.getTime() - DAY_MS);
      withExecutionContext(
        'organization_operator',
        () => {
          const seed = (action: string, count: number, at: Date) => {
            const deps = { tenantSlug, now: () => at };
            for (let i = 0; i < count; i++) {
              const receipt_id = `${action}-${at.getTime()}-${i}`;
              recordAutonomyOutcome(
                { action_id: action, receipt_id, decision: 'approve', executed: false },
                deps
              );
              recordAutonomyExecution({ action_id: action, receipt_id, ok: true }, deps);
            }
          };
          seed('stale_action', 10, old);
          seed('daemon_restart', 12, fresh);
          expect(resolveRole()).toBe('organization_operator');
          const deps = { tenantSlug, now: () => NOW };
          expect(listAutonomyActionIds(deps)).toEqual(['daemon_restart']);
          expect(actionAutonomyStats('daemon_restart', deps)).toMatchObject({
            decisions: 12,
            succeeded: 12,
          });
        },
        'worker',
        tenantSlug
      );

      const windowAudit = retentionAudits.find((r) => r.event === 'RETENTION_WINDOW');
      expect(windowAudit?.path).toBe(`${partition()}/autonomy-outcomes.jsonl`);
      expect(String(windowAudit?.archive_path)).toMatch(
        new RegExp(`^${partition()}/compaction-archive/`)
      );

      const live = asStore(() => [
        ...streamJsonLines<Partial<AutonomyOutcomeRow>>(
          pathResolver.rootResolve(`${partition()}/autonomy-outcomes.jsonl`),
          { onMalformed: 'skip' }
        ),
      ]);
      expect(live.some((row) => row.action_id === 'stale_action')).toBe(false);
      expect(live.filter((row) => row.action_id === 'daemon_restart')).toHaveLength(24);

      const archiveDir = pathResolver.rootResolve(`${partition()}/compaction-archive`);
      const archived = asOperator(() =>
        safeReaddir(archiveDir).flatMap((name) => [
          ...streamJsonLines<Partial<AutonomyOutcomeRow>>(`${archiveDir}/${name}`),
        ])
      );
      const staleArchived = new Set(
        archived
          .filter((row) => row.action_id === 'stale_action')
          .map((row) => `${row.kind ?? 'decision'}:${row.receipt_id}`)
      );
      expect(staleArchived.size).toBe(20);

      // No staging or publish temp is left behind in the partition.
      const names = asOperator(() => safeReaddir(pathResolver.rootResolve(partition())));
      expect(names.sort()).toEqual(['autonomy-outcomes.jsonl', 'compaction-archive']);
    });
  });
});
