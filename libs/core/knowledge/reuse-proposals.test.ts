import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { loadFacadeProposal } from './facade-proposal-rows.js';
import { reusableLearningBindingDigest } from './reusable-learning-binding.js';
import {
  captureMissionSeedProposal,
  LEARNING_INTAKE_PROPOSAL,
  migrateLegacyReuseProposals,
  MISSION_SEED_PROPOSAL,
} from './reuse-proposals.js';

const missionScope = {
  tier: 'confidential' as const,
  tenant_slug: 'reuse-proposal-tenant',
  mission_id: 'MSN-REUSE-SCOPED',
};
vi.mock('./memory-capture-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memory-capture-scope.js')>();
  return {
    ...actual,
    missionMemoryCaptureScope: (missionId: string) =>
      missionId === 'MSN-REUSE-SCOPED'
        ? { tier: 'confidential' as const, scope: missionScope }
        : { tier: 'confidential' as const },
  };
});

const queuePath = `active/shared/tmp/test-memory-queue-reuse-proposals-${process.pid}.jsonl`;
const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
const legacyPaths: string[] = [];
const suffix = `${process.pid}-${Date.now()}`;

beforeAll(() => {
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePath;
});
afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    for (const file of legacyPaths.splice(0)) safeRmSync(file, { force: true });
    safeRmSync(pathResolver.rootResolve(queuePath), { force: true });
  });
});
afterAll(() => {
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
});

function legacy(
  id: string,
  overrides: Partial<DistillCandidateRecord>,
  metadata: Record<string, unknown>
): DistillCandidateRecord {
  const record = createDistillCandidateRecord({
    candidate_id: `${id}-${suffix}`,
    source_type: 'mission',
    tier: 'confidential',
    title: `Legacy ${id}`,
    summary: `A legacy ${id} proposal written before D8.`,
    status: 'proposed',
    target_kind: 'pattern',
    evidence_refs: [`mission:${id}`],
    metadata,
    ...overrides,
  });
  legacyPaths.push(
    withExecutionContext('surface_runtime', () => saveDistillCandidateRecord(record))
  );
  return record;
}

describe('reuse proposals on the queue (D8)', () => {
  it('captures a mission-seed proposal with the mission scope and the project, or not at all', () => {
    const captured = withExecutionContext('surface_runtime', () =>
      captureMissionSeedProposal({
        missionId: 'MSN-REUSE-SCOPED',
        project: {
          project_id: 'proj-reuse',
          organization_id: 'org-reuse',
          tenant_slug: missionScope.tenant_slug,
        },
        seed: { seed_id: 'SEED-1', title: 'Quarterly close', track_id: 'TRK-1' },
        targetKind: 'sop_candidate',
        metadata: { promotion_source: 'mission_seed' },
      })
    );
    expect(captured).toMatchObject({
      status: 'proposed',
      record_kind: 'mission_seed',
      decided_via: 'concierge',
      project_id: 'proj-reuse',
      track_id: 'TRK-1',
      scope: { ...missionScope, organization_id: 'org-reuse', project_id: 'proj-reuse' },
    });
    expect(
      withExecutionContext('surface_runtime', () =>
        captureMissionSeedProposal({
          missionId: 'MSN-REUSE-NO-TENANT',
          project: { project_id: 'proj-reuse' },
          seed: { seed_id: 'SEED-2', title: 'No tenant' },
          targetKind: 'pattern',
          metadata: {},
        })
      )
    ).toBeNull();
  });

  it('migrates pending legacy records with their declared scope and never guesses one', () => {
    const plan = { version: 1, scope: { tier: 'public' }, source_ref: 'x', source_sha256: 'y' };
    const intake = legacy(
      'DSC-LEARN-LEGACY',
      { tier: 'public', source_type: 'artifact', target_kind: 'pattern' },
      { origin: 'learning_intake', learning_plan: plan }
    );
    const seed = legacy(
      'DSC-SEED-LEGACY',
      { mission_id: 'MSN-REUSE-SCOPED' },
      { promotion_source: 'mission_seed' }
    );
    const seedNoTenant = legacy(
      'DSC-SEED-NO-TENANT',
      { mission_id: 'MSN-REUSE-NO-TENANT' },
      { promotion_source: 'mission_seed' }
    );
    const browser = legacy(
      'DSC-BROWSER-LEGACY',
      { source_type: 'task_session', target_kind: 'sop_candidate' },
      { surface: 'browser-extension', origin: 'https://example.test' }
    );
    const service = legacy(
      'DSC-SVC-LEGACY',
      { source_type: 'task_session', tier: 'personal', target_kind: 'procedure' },
      { procedure: { procedure_id: 'p' }, executable: false }
    );
    const decided = legacy(
      'DSC-SEED-DECIDED',
      { mission_id: 'MSN-REUSE-SCOPED', status: 'promoted' },
      { promotion_source: 'mission_seed' }
    );
    const ours = (ids: string[]) => ids.filter((id) => id.endsWith(suffix)).sort();

    const dryRun = withExecutionContext('surface_runtime', () => migrateLegacyReuseProposals());
    expect(dryRun.mode).toBe('dry_run');
    expect(ours(dryRun.imported.map((entry) => entry.candidate_id))).toEqual(
      [intake.candidate_id, seed.candidate_id].sort()
    );
    expect(ours(dryRun.unresolved.map((entry) => entry.candidate_id))).toEqual(
      [seedNoTenant.candidate_id, browser.candidate_id, service.candidate_id].sort()
    );
    expect(ours(dryRun.left_as_history)).toEqual([decided.candidate_id]);
    expect(loadFacadeProposal(MISSION_SEED_PROPOSAL, seed.candidate_id)).toBeNull();

    const before = String(safeReadFile(legacyPaths[1]!, { encoding: 'utf8' }));
    const applied = withExecutionContext('surface_runtime', () =>
      migrateLegacyReuseProposals({ apply: true })
    );
    expect(ours(applied.imported.map((entry) => entry.candidate_id))).toEqual(
      [intake.candidate_id, seed.candidate_id].sort()
    );
    expect(
      loadFacadeProposal(MISSION_SEED_PROPOSAL, seed.candidate_id, missionScope)
    ).toMatchObject({
      status: 'proposed',
      scope: missionScope,
      migrated_from: 'distill-candidate-registry',
    });
    const migratedIntake = loadFacadeProposal(LEARNING_INTAKE_PROPOSAL, intake.candidate_id, {
      tier: 'public',
    })!;
    // Steward review rows queued from the legacy plan keep resolving.
    expect(reusableLearningBindingDigest(migratedIntake)).toBe(
      reusableLearningBindingDigest(intake)
    );
    // Legacy records stay as written (read-only history).
    expect(String(safeReadFile(legacyPaths[1]!, { encoding: 'utf8' }))).toBe(before);

    const again = withExecutionContext('surface_runtime', () =>
      migrateLegacyReuseProposals({ apply: true })
    );
    expect(ours(again.imported.map((entry) => entry.candidate_id))).toEqual([]);
    expect(ours(again.already_on_queue)).toEqual([intake.candidate_id, seed.candidate_id].sort());
  });
});
