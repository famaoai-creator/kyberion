import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRole, withExecutionContext } from '../authority.js';
import { safeExistsSync, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { pipelineJournalCapability } from '../foundation/pipeline-journal-capability.js';
import {
  assertPipelineRunJournalCreatable,
  createPipelineRunJournal,
  loadPipelineRunJournal,
  openPipelineRunJournal,
  pipelineRunJournalPath,
} from './pipeline-run-journal.js';

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
      () => safeRmSync(journalDir(), { recursive: true, force: true }),
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
    runInResourceAccessScope(pipelineJournalCapability(tenantSlug, file), () =>
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
