import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '../secure-io.js';
import { withExecutionContext as inSourceContext } from '../authority.js';
import type { AutonomyOutcomeRow } from './autonomy-action-state.js';

// Keep the retention audit out of the shared audit log during tests.
const retentionAudits = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../storage-retention-expiry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage-retention-expiry.js')>();
  return {
    ...actual,
    appendRetentionAudit: (record: Record<string, unknown>) => retentionAudits.push(record),
  };
});

const sourceRoot = process.cwd();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp', `tenant-autonomy-${randomUUID()}`);
let resolveRole: typeof import('../authority.js').resolveRole;
let withExecutionContext: typeof import('../authority.js').withExecutionContext;
let safeReaddir: typeof import('../secure-io.js').safeReaddir;
let safeWriteFile: typeof import('../secure-io.js').safeWriteFile;
let safeMkdir: typeof import('../secure-io.js').safeMkdir;
let pathResolver: typeof import('../path-resolver.js').pathResolver;
let validateWritePermission: typeof import('../tier-guard.js').validateWritePermission;
let streamJsonLines: typeof import('../jsonl-read.js').streamJsonLines;
let resetAppendOnlyStoreMaintenanceState: typeof import('../append-only-store.js').resetAppendOnlyStoreMaintenanceState;
let autonomyLearningCapability: typeof import('../foundation/autonomy-learning-capability.js').autonomyLearningCapability;
let withAutonomyLearningCapability: typeof import('../foundation/autonomy-learning-capability.js').withAutonomyLearningCapability;
let runInResourceAccessScope: typeof import('../foundation/resource-access-scope.js').runInResourceAccessScope;
let AUTONOMY_OUTCOMES_MIN_RETENTION_MS: typeof import('./autonomy-action-state.js').AUTONOMY_OUTCOMES_MIN_RETENTION_MS;
let AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS: typeof import('./autonomy-action-state.js').AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS;
let setAutonomyOutcomesStoreTuningForTests: typeof import('./autonomy-action-state.js').setAutonomyOutcomesStoreTuningForTests;
let listAutonomyActionIds: typeof import('./autonomy-action-state.js').listAutonomyActionIds;
let actionAutonomyStats: typeof import('./autonomy-action-state.js').actionAutonomyStats;
let recordAutonomyExecution: typeof import('./autonomy-action-state.js').recordAutonomyExecution;
let recordAutonomyOutcome: typeof import('./autonomy-action-state.js').recordAutonomyOutcome;
let sweepAutonomyActionStates: typeof import('./autonomy-action-state.js').sweepAutonomyActionStates;
let applyAutonomyOverride: typeof import('./autonomy-action-state.js').applyAutonomyOverride;

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, fixtureRoot);
  process.chdir(fixtureRoot);
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('VITEST', '');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
  for (const key of [
    'SYSTEM_ROLE',
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_TASK_ID',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_STANCE',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(key, '');
  vi.resetModules();
  ({ resolveRole, withExecutionContext } = await import('../authority.js'));
  ({ safeReaddir, safeWriteFile, safeMkdir } = await import('../secure-io.js'));
  ({ pathResolver } = await import('../path-resolver.js'));
  ({ validateWritePermission } = await import('../tier-guard.js'));
  ({ streamJsonLines } = await import('../jsonl-read.js'));
  ({ resetAppendOnlyStoreMaintenanceState } = await import('../append-only-store.js'));
  ({ autonomyLearningCapability, withAutonomyLearningCapability } =
    await import('../foundation/autonomy-learning-capability.js'));
  ({ runInResourceAccessScope } = await import('../foundation/resource-access-scope.js'));
  ({
    AUTONOMY_OUTCOMES_MIN_RETENTION_MS,
    AUTONOMY_OUTCOMES_RETENTION_MARGIN_MS,
    setAutonomyOutcomesStoreTuningForTests,
    listAutonomyActionIds,
    actionAutonomyStats,
    recordAutonomyExecution,
    recordAutonomyOutcome,
    sweepAutonomyActionStates,
    applyAutonomyOverride,
  } = await import('./autonomy-action-state.js'));
  expect(pathResolver.rootDir()).toBe(fixtureRoot);
  expect(pathResolver.primaryCheckoutRootDir()).toBe(fixtureRoot);
  // runtime-readiness.ts requires this onboarding floor; the bounded API
  // must create the absent store root, tier and tenant partition itself.
  withExecutionContext('ecosystem_architect', () => safeMkdir(pathResolver.shared('runtime')));
  expect(safeReaddir(pathResolver.shared('runtime'))).not.toContain('autonomy-learning');
}, 60000);

afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  inSourceContext('ecosystem_architect', () =>
    removeFixture(fixtureRoot, { recursive: true, force: true })
  );
  vi.resetModules();
});

describe('production tenant autonomy store grant mediation', () => {
  let tenantSlug: string;
  beforeEach(() => {
    tenantSlug = `vitest-learning-${randomUUID().slice(0, 8)}`;
    vi.stubEnv('SYSTEM_ROLE', '');
    expect(pathResolver.rootDir()).toBe(fixtureRoot);
    expect(pathResolver.primaryCheckoutRootDir()).toBe(fixtureRoot);
    expect(pathResolver.shared(`runtime/autonomy-learning/confidential/${tenantSlug}`)).toBe(
      path.join(fixtureRoot, 'active/shared/runtime/autonomy-learning/confidential', tenantSlug)
    );
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeWriteFile(
          pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`),
          JSON.stringify({
            tenant_slug: tenantSlug,
            status: 'active',
            display_name: 'Synthetic autonomy tenant',
            assigned_role: 'owner',
          })
        ),
      'ecosystem_architect'
    );
  });
  afterEach(() => {
    vi.stubEnv('SYSTEM_ROLE', '');
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

  it('the grant alone authorizes its exact tenant ceiling; the former role grants nothing', () => {
    const directory = `active/shared/runtime/autonomy-learning/confidential/${tenantSlug}`;
    const outcomes = pathResolver.rootResolve(`${directory}/autonomy-outcomes.jsonl`);
    // G2: the former role name is an issuance right, not an assumable role.
    expect(() =>
      withExecutionContext('autonomy_learning_store', () => undefined, 'worker', tenantSlug)
    ).toThrow('ROLE_ASSUMPTION_DENIED');
    // A role-less caller (persona worker, no store grant of its own) bound to the tenant.
    const caller = <T>(fn: () => T): T =>
      withExecutionContext('chronos_gateway', fn, 'worker', tenantSlug);
    caller(() => {
      expect(validateWritePermission(outcomes, 'append')).toMatchObject({ allowed: false });
      // A structural lookalike of the exact ceiling is not the issued grant.
      runInResourceAccessScope(autonomyLearningCapability(tenantSlug), () =>
        expect(validateWritePermission(outcomes, 'append')).toMatchObject({ allowed: false })
      );
      withAutonomyLearningCapability(tenantSlug, directory, () => {
        expect(resolveRole()).toBe('chronos_gateway');
        expect(validateWritePermission(outcomes, 'append')).toMatchObject({ allowed: true });
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
      });
      expect(validateWritePermission(outcomes, 'append')).toMatchObject({ allowed: false });
    });
    // A process still launched as the former role gets no I/O at all.
    vi.stubEnv('SYSTEM_ROLE', 'autonomy_learning_store');
    expect(validateWritePermission(outcomes, 'write').reason).toContain('ROLE_ASSUMPTION_DENIED');
    vi.stubEnv('SYSTEM_ROLE', '');
  });

  it('issues the grant only where the former shared role could be assumed', () => {
    vi.stubEnv('SYSTEM_ROLE', 'zz_unlisted_surface');
    expect(() =>
      recordAutonomyOutcome(
        { action_id: 'never', receipt_id: randomUUID(), decision: 'approve', executed: false },
        { tenantSlug }
      )
    ).toThrow('ROLE_ASSUMPTION_DENIED');
    vi.stubEnv('SYSTEM_ROLE', '');
  });

  describe('write-time retention of the tenant partition', () => {
    const partition = () => `active/shared/runtime/autonomy-learning/confidential/${tenantSlug}`;
    const asStore = <T>(fn: () => T): T =>
      withExecutionContext(
        'chronos_gateway',
        () => withAutonomyLearningCapability(tenantSlug, partition(), fn),
        'worker',
        tenantSlug
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
