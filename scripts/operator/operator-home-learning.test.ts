import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleFeedbackSubcommand,
  handleImprovements,
  improvementsArgsFromArgv,
} from './operator-home-secondary-actions.js';
import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
} from '@agent/core/knowledge/distill-candidate-registry';
import * as path from 'node:path';
import {
  resolveExecutionFeedbackPath,
  listExecutionFeedbackCandidates,
} from '@agent/core/execution-feedback';
import {
  listMemoryPromotionCandidates,
  memoryPromotionQueuePath,
} from '@agent/core/knowledge/memory-promotion-queue';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
const selected = vi.hoisted(() => ({ scope: { tier: 'public' } as MemoryScopeEnvelope }));
vi.mock('@agent/core/scope-context', async (original) => ({
  ...(await original<object>()),
  currentScope: () => selected.scope,
}));
const scope = { tier: 'confidential' as const, tenant_slug: 'synthetic-learning-cli' };
const executionFeedbackScopeRoot = (scope: MemoryScopeEnvelope) =>
  path.dirname(resolveExecutionFeedbackPath(scope));
const executionFeedbackCandidatePath = (id: string, scope?: MemoryScopeEnvelope) =>
  scope
    ? path.join(executionFeedbackScopeRoot(scope), 'candidates', id + '.json')
    : pathResolver.shared('runtime/distill-candidates/' + id + '.json');
const legacyIds = new Set<string>();
const ui = (key: string) => key;
/** D8: the proposal is a queue row; snapshot its view instead of a file. */
const snapshot = (id: string) =>
  JSON.stringify(listExecutionFeedbackCandidates(scope).find((row) => row.candidate_id === id));
/** Learning rows handed to human review (`MEM-FB-*`). */
const learningRows = () =>
  listMemoryPromotionCandidates(scope).filter((row) => row.candidate_id.startsWith('MEM-FB-'));
afterEach(() => {
  safeRmSync(executionFeedbackScopeRoot(scope), { recursive: true, force: true });
  safeRmSync(memoryPromotionQueuePath(scope), { force: true });
  for (const id of legacyIds) safeRmSync(executionFeedbackCandidatePath(id), { force: true });
  legacyIds.clear();
  selected.scope = { tier: 'public' };
});
function feedback() {
  selected.scope = scope;
  handleFeedbackSubcommand(ui, {
    intentId: 'synthetic-meeting',
    outcome: 'dissatisfied',
    correction: 'Share the fictional meeting brief before review.',
  });
  return listExecutionFeedbackCandidates(scope)[0];
}
describe('operator learning command boundary', () => {
  it('passes the selected scope into feedback and separates read-only review from explicit queue', () => {
    const row = feedback();
    expect(row.scope).toEqual(scope);
    const before = snapshot(row.candidate_id);
    const output: unknown[] = [];
    handleImprovements(ui, { review: row.candidate_id, json: true }, (value) => output.push(value));
    expect(JSON.parse(String(output[0]))).toMatchObject({
      queue: { status: 'not_queued' },
      human_review: { status: 'pending' },
      promotion: { status: 'none' },
      retrieval: { status: 'unmeasured' },
    });
    expect(snapshot(row.candidate_id)).toBe(before);
    expect(learningRows()).toEqual([]);
    handleImprovements(ui, { queue: row.candidate_id });
    expect(learningRows()).toHaveLength(1);
    expect(
      listExecutionFeedbackCandidates(scope).find(
        (entry) => entry.candidate_id === row.candidate_id
      )?.status
    ).toBe('proposed');
  });
  it.each(['approve', 'deny'] as const)(
    'does not let legacy --%s fake a human decision',
    (action) => {
      const row = feedback();
      const before = snapshot(row.candidate_id);
      expect(() => handleImprovements(ui, { [action]: row.candidate_id })).toThrow();
      expect(snapshot(row.candidate_id)).toBe(before);
      expect(learningRows()).toEqual([]);
    }
  );
  it.each(['personal', 'confidential'] as const)(
    'refuses selected %s scope without a tenant instead of writing global feedback',
    (tier) => {
      selected.scope = { tier };
      const file = resolveExecutionFeedbackPath();
      const before = safeExistsSync(file) ? safeReadFile(file, { encoding: 'utf8' }) : null;
      expect(() =>
        handleFeedbackSubcommand(ui, { intentId: 'synthetic', outcome: 'dissatisfied' })
      ).toThrow(/SCOPE/);
      expect(safeExistsSync(file) ? safeReadFile(file, { encoding: 'utf8' }) : null).toBe(before);
    }
  );
  it('requires an explicit legacy review flag and never associates that proposal with selected tenant', () => {
    const row = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'personal',
      title: 'Synthetic legacy',
      summary: 'Synthetic legacy correction.',
      status: 'proposed',
      target_kind: 'procedure',
      metadata: { improvement_kind: 'execution_feedback' },
    });
    saveDistillCandidateRecord(row);
    legacyIds.add(row.candidate_id);
    selected.scope = scope;
    // D8: legacy records are read-only; unscoped ones are reported, never adopted.
    expect(() =>
      handleImprovements(ui, { review: row.candidate_id, queue: row.candidate_id })
    ).toThrow();
    expect(() => handleImprovements(ui, { review: row.candidate_id })).toThrow(/NOT_FOUND/);
    const output: unknown[] = [];
    handleImprovements(ui, { review: row.candidate_id, legacy: true, json: true }, (value) =>
      output.push(value)
    );
    expect(JSON.parse(String(output[0]))).toMatchObject({
      scope_disposition: 'legacy_unscoped',
      queue: { status: 'not_queued' },
    });
    expect(() => handleImprovements(ui, { queue: row.candidate_id, legacy: true })).toThrow();
    expect(() => handleImprovements(ui, { legacy: true })).toThrow();
    expect(loadDistillCandidateRecord(row.candidate_id)?.scope).toBeUndefined();
    const entrypoint = String(
      safeReadFile(pathResolver.rootResolve('scripts/kyberion_home.ts'), { encoding: 'utf8' })
    );
    expect(entrypoint).toContain(".option('legacy'");
    expect(entrypoint).toContain('improvementsArgsFromArgv(argv)');
    expect(improvementsArgsFromArgv({ legacy: true, review: 'id-1' })).toMatchObject({
      legacy: true,
      review: 'id-1',
    });
  });
  it('migrates pending scoped legacy proposals with their own scope and reports unscoped ones (one release)', () => {
    const legacyUnscoped = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'personal',
      title: 'Synthetic unscoped legacy',
      summary: 'Synthetic legacy correction without a scope.',
      status: 'proposed',
      target_kind: 'procedure',
      evidence_refs: ['intent:synthetic-legacy'],
      metadata: { improvement_kind: 'execution_feedback' },
    });
    saveDistillCandidateRecord(legacyUnscoped);
    legacyIds.add(legacyUnscoped.candidate_id);
    const legacyScoped = createDistillCandidateRecord({
      source_type: 'task_session',
      tier: 'confidential',
      scope,
      title: 'Synthetic scoped legacy',
      summary: 'Synthetic legacy correction in a tenant scope.',
      status: 'proposed',
      target_kind: 'procedure',
      evidence_refs: ['intent:synthetic-legacy-scoped'],
      metadata: { improvement_kind: 'execution_feedback' },
    });
    const scopedFile = executionFeedbackCandidatePath(legacyScoped.candidate_id, scope);
    safeMkdir(path.dirname(scopedFile), { recursive: true });
    safeWriteFile(scopedFile, JSON.stringify(legacyScoped, null, 2));
    selected.scope = scope;
    const before = String(safeReadFile(scopedFile, { encoding: 'utf8' }));
    const dryRun: unknown[] = [];
    handleImprovements(ui, { migrate: true }, (value) => dryRun.push(value));
    const report = JSON.parse(String(dryRun[0]));
    expect(report.mode).toBe('dry_run');
    expect(report.imported).toEqual([
      expect.objectContaining({ candidate_id: legacyScoped.candidate_id }),
    ]);
    expect(report.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate_id: legacyUnscoped.candidate_id }),
      ])
    );
    expect(
      listMemoryPromotionCandidates(scope).some(
        (entry) => entry.candidate_id === legacyScoped.candidate_id
      )
    ).toBe(false);
    expect(() => handleImprovements(ui, { write: true })).toThrow(/--migrate/);
    handleImprovements(ui, { migrate: true, write: true }, () => undefined);
    expect(
      listMemoryPromotionCandidates(scope).find(
        (entry) => entry.candidate_id === legacyScoped.candidate_id
      )
    ).toMatchObject({
      kind: 'execution_feedback',
      scope,
      origin: { record_kind: 'execution_feedback', migrated_from: 'distill-candidate-registry' },
    });
    // The legacy file is untouched history; a second run is a no-op.
    expect(String(safeReadFile(scopedFile, { encoding: 'utf8' }))).toBe(before);
    const again: unknown[] = [];
    handleImprovements(ui, { migrate: true, write: true }, (value) => again.push(value));
    expect(JSON.parse(String(again[0])).already_on_queue).toContain(legacyScoped.candidate_id);
  });
});
