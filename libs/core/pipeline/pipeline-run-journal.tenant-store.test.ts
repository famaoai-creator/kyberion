import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '../secure-io.js';
import { withExecutionContext as inSourceContext } from '../authority.js';

const sourceRoot = process.cwd();
const fixtureRoot = path.join(sourceRoot, 'active/shared/tmp', `tenant-journal-${randomUUID()}`);
let resolveRole: typeof import('../authority.js').resolveRole;
let withExecutionContext: typeof import('../authority.js').withExecutionContext;
let safeExistsSync: typeof import('../secure-io.js').safeExistsSync;
let safeWriteFile: typeof import('../secure-io.js').safeWriteFile;
let safeMkdir: typeof import('../secure-io.js').safeMkdir;
let pathResolver: typeof import('../path-resolver.js').pathResolver;
let runInResourceAccessScope: typeof import('../foundation/resource-access-scope.js').runInResourceAccessScope;
let pipelineJournalCapability: typeof import('../foundation/pipeline-journal-capability.js').pipelineJournalCapability;
let withPipelineJournalCapability: typeof import('../foundation/pipeline-journal-capability.js').withPipelineJournalCapability;
let assertPipelineRunJournalCreatable: typeof import('./pipeline-run-journal.js').assertPipelineRunJournalCreatable;
let createPipelineRunJournal: typeof import('./pipeline-run-journal.js').createPipelineRunJournal;
let loadPipelineRunJournal: typeof import('./pipeline-run-journal.js').loadPipelineRunJournal;
let openPipelineRunJournal: typeof import('./pipeline-run-journal.js').openPipelineRunJournal;
let pipelineRunJournalPath: typeof import('./pipeline-run-journal.js').pipelineRunJournalPath;

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
  // Default journal paths capture rootDir/shared at import; isolate the real
  // selected and primary roots rather than merely spying on one namespace.
  vi.resetModules();
  ({ resolveRole, withExecutionContext } = await import('../authority.js'));
  ({ safeExistsSync, safeWriteFile, safeMkdir } = await import('../secure-io.js'));
  ({ pathResolver } = await import('../path-resolver.js'));
  ({ runInResourceAccessScope } = await import('../foundation/resource-access-scope.js'));
  ({ pipelineJournalCapability, withPipelineJournalCapability } =
    await import('../foundation/pipeline-journal-capability.js'));
  ({
    assertPipelineRunJournalCreatable,
    createPipelineRunJournal,
    loadPipelineRunJournal,
    openPipelineRunJournal,
    pipelineRunJournalPath,
  } = await import('./pipeline-run-journal.js'));
  expect(pathResolver.rootDir()).toBe(fixtureRoot);
  expect(pathResolver.primaryCheckoutRootDir()).toBe(fixtureRoot);
  // runtime-readiness.ts requires this onboarding floor; the bounded API
  // must create the absent store root, tier and tenant partition itself.
  withExecutionContext('ecosystem_architect', () => safeMkdir(pathResolver.shared('runtime')));
  expect(safeExistsSync(pathResolver.shared('runtime/pipeline-library-runs'))).toBe(false);
}, 60000);

afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  inSourceContext('ecosystem_architect', () =>
    removeFixture(fixtureRoot, { recursive: true, force: true })
  );
  vi.resetModules();
});

/**
 * Real permission floors (not the writable Vitest sandbox): a dot executor
 * runs a tenant pipeline as its charter role bound to the tenant, and the
 * delegated library run must create its confidential run journal.
 */
describe('tenant confidential library run journal', () => {
  let tenantSlug: string;
  const journalDir = () =>
    pathResolver.rootResolve(
      `active/shared/runtime/pipeline-library-runs/confidential/${tenantSlug}`
    );
  const started = () => ({
    pipeline_id: 'tenant-journal-test',
    input_path: pathResolver.rootResolve('pipelines/continuous-operations-report.json'),
    step_ids: ['report'],
  });
  const asOperator = <T>(fn: () => T, tenant = tenantSlug): T =>
    withExecutionContext('organization_operator', fn, 'worker', tenant, tenant);

  beforeEach(() => {
    tenantSlug = `vitest-journal-${randomUUID().slice(0, 8)}`;
    expect(pathResolver.rootDir()).toBe(fixtureRoot);
    expect(pathResolver.primaryCheckoutRootDir()).toBe(fixtureRoot);
    expect(journalDir()).toBe(
      path.join(fixtureRoot, 'active/shared/runtime/pipeline-library-runs/confidential', tenantSlug)
    );
    withExecutionContext(
      'ecosystem_architect',
      () =>
        safeWriteFile(
          pathResolver.rootResolve(`knowledge/personal/tenants/${tenantSlug}.json`),
          JSON.stringify({
            tenant_slug: tenantSlug,
            status: 'active',
            display_name: 'Synthetic journal tenant',
            assigned_role: 'owner',
          })
        ),
      'ecosystem_architect'
    );
  });

  it('lets the tenant-bound charter role create and append its own run journal', () => {
    const scope = { tier: 'confidential' as const, tenantSlug };
    const runId = randomUUID();
    asOperator(() => {
      expect(() => assertPipelineRunJournalCreatable(runId, scope)).not.toThrow();
      const journal = createPipelineRunJournal(runId, started(), undefined, scope);
      journal.append('run_finished', { status: 'succeeded' });
      // The narrow store role is scoped to the journal IO only.
      expect(resolveRole()).toBe('organization_operator');
      expect(journal.state().finished?.status).toBe('succeeded');
    });
    expect(safeExistsSync(pipelineRunJournalPath(runId, undefined, scope))).toBe(true);
  });

  it('reads and resumes the run under a charter role without tenant knowledge grants', () => {
    // infrastructure_sentinel holds no knowledge/confidential read grant of its own.
    const scope = { tier: 'confidential' as const, tenantSlug };
    const runId = randomUUID();
    withExecutionContext(
      'infrastructure_sentinel',
      () => {
        const journal = createPipelineRunJournal(runId, started(), undefined, scope);
        expect(journal.state().started?.pipeline_id).toBe('tenant-journal-test');
        const loaded = loadPipelineRunJournal(runId, undefined, scope);
        openPipelineRunJournal(loaded).append('run_resumed', { resumed_at: 'now' });
        expect(loadPipelineRunJournal(runId, undefined, scope).events.at(-1)?.event).toBe(
          'run_resumed'
        );
        expect(resolveRole()).toBe('infrastructure_sentinel');
      },
      'worker',
      tenantSlug
    );
  });

  it('never widens: another tenant, or tenant knowledge, stays denied', () => {
    const other = { tier: 'confidential' as const, tenantSlug: `${tenantSlug}-other` };
    asOperator(() => {
      expect(() => assertPipelineRunJournalCreatable(randomUUID(), other)).toThrow(
        '[PIPELINE_JOURNAL] run journal cannot be created'
      );
      expect(() =>
        safeWriteFile(pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/x.json`), '{}')
      ).toThrow();
    });
    const file = `active/shared/runtime/pipeline-library-runs/confidential/${tenantSlug}/r.jsonl`;
    expect(() =>
      withExecutionContext('pipeline_journal_store', () => undefined, 'worker', tenantSlug)
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    // G2: a structural lookalike of the exact ceiling is not the issued grant.
    expect(() =>
      runInResourceAccessScope(pipelineJournalCapability(tenantSlug, file), () =>
        withExecutionContext('pipeline_journal_store', () => undefined, 'worker', tenantSlug)
      )
    ).toThrow('RESOURCE_SCOPE_REQUIRED');
    withPipelineJournalCapability(tenantSlug, file, true, () =>
      withExecutionContext(
        'pipeline_journal_store',
        () => {
          expect(() =>
            safeWriteFile(
              pathResolver.rootResolve(`knowledge/confidential/${tenantSlug}/r.jsonl`),
              '{}'
            )
          ).toThrow('RESOURCE_SCOPE_DENIED');
          expect(() =>
            safeWriteFile(pathResolver.rootResolve(file.replace('r.jsonl', 'q.jsonl')), '{}')
          ).toThrow('RESOURCE_SCOPE_DENIED');
        },
        'worker',
        tenantSlug
      )
    );
    expect(() =>
      pipelineJournalCapability(tenantSlug, `knowledge/confidential/${tenantSlug}/r.jsonl`)
    ).toThrow('RESOURCE_SCOPE_INVALID');
  });
});
