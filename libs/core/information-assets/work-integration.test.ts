import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  createWorkItemIfAbsent,
  claimWorkItem,
  releaseWorkItem,
  getWorkItem,
  updateWorkItem,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import { setDotBudgetThrottleForTests } from '../dot/dot-budget.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { InformationAssetObservation } from './types.js';
import {
  loadInformationIntakeRecipes,
  dispatchInformationAssetRecipes,
  INFORMATION_ASSET_WORK_PIPELINE,
} from './recipes.js';
import { executeInformationAssetWork } from './work-execution.js';
const recipes = loadInformationIntakeRecipes();
let scratch: string;
beforeEach(() => {
  setWorkCoordinationNamespace('information-work-' + randomUUID());
  scratch = pathResolver.sharedTmp('information-work-' + randomUUID());
  setDotBudgetThrottleForTests(() => 'normal');
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  setDotBudgetThrottleForTests(undefined);
  safeRmSync(scratch, { recursive: true, force: true });
});
describe('accepted observation through existing Dot admission and claimed WorkItem', () => {
  for (const recipeId of ['email.morning_triage', 'github.review_request', 'jira.assignment'])
    it(recipeId + ' completes an admitted fixture and deduplicates delivery', async () => {
      const recipe = recipes.find((r) => r.recipe_id === recipeId)!;
      const scope = { tenant_slug: 'acme', organization_id: 'support' };
      const charter: DotCharter = {
        kind: 'dot-charter',
        dot_id: 'information-fixture',
        version: '1',
        title: 'Fixture',
        purpose: 'Process fixture',
        status: 'active',
        scope: { ...scope, tier: 'confidential' },
        goal: { statement: 'Handle observed work' },
        attention: { triggers: [] },
        authority: {
          authority_role: 'organization_operator',
          allowed_work_shapes: ['pipeline'],
          allowed_pipelines: [INFORMATION_ASSET_WORK_PIPELINE],
          max_concurrent_delegations: 10,
        },
        notification: { deliver_to: { surface: 'surface', channel: 'fixture' } },
        runtime: { heartbeat_id: 'fixture' },
      };
      const observation: InformationAssetObservation = {
        scope,
        event_id: 'e'.repeat(64),
        asset_type: recipe.asset_type,
        location_id: 'fixture-source',
        binding_id: 'fixture-binding',
        service_id: recipeId.startsWith('email')
          ? 'google-workspace'
          : recipeId.startsWith('github')
            ? 'github'
            : 'jira',
        subject_id: 'object1',
        change_id: 'revision1',
        event_type: recipe.event_types[0],
        observed_at: '2026-11-02T00:00:00Z',
        content_sha256: 'c'.repeat(64),
        data: { subject: 'Fixture' },
      };
      const gate = vi.fn((input) => ({
        actionId: input.actionId,
        decision: 'auto' as const,
        allowed: true,
        score: 0,
        maxScore: 6,
        policyVersion: 'fixture',
        executionMode: 'apply' as const,
        reason: 'Fixture admission',
        axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
        shadow: false,
        escalations: [],
        highRiskPathMatches: [],
      }));
      const create = vi.fn((input) => createWorkItemIfAbsent({ ...input, rootDir: undefined }));
      const dispatchDeps = {
        rootDir: scratch,
        recipes,
        recipeIds: [recipeId],
        gate,
        route: () => ({
          level: 'none' as const,
          timing: 'digest' as const,
          proceed: true,
          parked: false,
          shadow: false,
          notified: false,
        }),
        createWorkItem: create,
        countOpenWorkItems: () => 0,
        listCharters: () => [charter],
        assertTenant: () => {},
        appendInbox: () => {},
        notify: () => true,
        audit: () => {},
        feedback: { onRejection: () => {} },
      };
      const accepted = dispatchInformationAssetRecipes(observation, charter, dispatchDeps);
      expect(accepted[0].records[0].status).toBe('dispatched');
      expect(gate).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(
        dispatchInformationAssetRecipes(observation, charter, dispatchDeps)[0].duplicates
      ).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      const itemId = accepted[0].records[0].work_item_id!;
      const claim = claimWorkItem({
        itemId,
        actorPeerId: 'dot:information-fixture',
        purpose: 'fixture',
        requireNewLease: true,
      });
      let artifact = '';
      const outcome = await executeInformationAssetWork(
        {
          workItemId: itemId,
          attemptId: claim.item.current_attempt_id!,
          leaseId: claim.lease.lease_id,
          dotId: charter.dot_id,
          actorId: 'dot:information-fixture',
        },
        {
          tier: 'confidential',
          rootDir: scratch,
          recipes,
          loadObservation: () => observation,
          getItem: (id) => getWorkItem(id),
          updateItem: (input) => updateWorkItem({ ...input, rootDir: undefined }),
          prepare: async () => ({ kind: 'artifact', text: 'Fixture completed' }),
          writeArtifact: (_binding, text) => {
            artifact = text;
            return 'fixture-artifact';
          },
          readArtifact: () => artifact,
        }
      );
      expect(outcome.status).toBe('completed');
      releaseWorkItem({
        itemId,
        leaseId: claim.lease.lease_id,
        actorPeerId: 'dot:information-fixture',
        nextStatus: 'done',
        effectDisposition: 'completed',
      });
      expect(getWorkItem(itemId)?.status).toBe('done');
      expect(
        dispatchInformationAssetRecipes(observation, charter, dispatchDeps)[0].duplicates
      ).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(
        dispatchInformationAssetRecipes(
          { ...observation, event_id: 'f'.repeat(64), change_id: 'revision2' },
          charter,
          dispatchDeps
        )[0].records[0].status
      ).toBe('dispatched');
      expect(create).toHaveBeenCalledTimes(2);
      expect(getWorkItem(itemId)?.context).toMatchObject(scope);
      expect(getWorkItem(itemId)?.metadata?.information_asset_outcome).toMatchObject({
        status: 'completed',
        evidence_sha256: outcome.evidence_sha256,
      });
    });
});
