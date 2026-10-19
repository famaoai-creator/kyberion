import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFeedbackSubcommand, handleImprovements } from './operator-home-secondary-actions.js';
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
import { memoryPromotionQueuePath } from '@agent/core/knowledge/memory-promotion-queue';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
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
    const file = executionFeedbackCandidatePath(row.candidate_id, scope);
    const before = safeReadFile(file, { encoding: 'utf8' });
    const output: unknown[] = [];
    handleImprovements(ui, { review: row.candidate_id, json: true }, (value) => output.push(value));
    expect(JSON.parse(String(output[0]))).toMatchObject({
      queue: { status: 'not_queued' },
      human_review: { status: 'pending' },
      promotion: { status: 'none' },
      retrieval: { status: 'unmeasured' },
    });
    expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
    expect(safeExistsSync(memoryPromotionQueuePath(scope))).toBe(false);
    handleImprovements(ui, { queue: row.candidate_id });
    expect(safeExistsSync(memoryPromotionQueuePath(scope))).toBe(true);
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
      const file = executionFeedbackCandidatePath(row.candidate_id, scope);
      const before = safeReadFile(file, { encoding: 'utf8' });
      expect(() => handleImprovements(ui, { [action]: row.candidate_id })).toThrow();
      expect(safeReadFile(file, { encoding: 'utf8' })).toBe(before);
      expect(safeExistsSync(memoryPromotionQueuePath(scope))).toBe(false);
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
    expect(entrypoint).toContain('legacy: Boolean(argv.legacy)');
  });
});
