import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import {
  clearWorkCoordinationNamespace,
  compileSchemaFromPath,
  getWorkItem,
  importExternalWorkItem,
  pathResolver,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  setWorkCoordinationNamespace,
  sha256,
} from '@agent/core';
import {
  reconcileMissionExistingWork,
  type MissionWorkReconciliationManifest,
} from './mission-work-reconciliation.js';

const missionId = 'MSN-WORK-RECONCILIATION-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
const fixtureRoot = pathResolver.sharedTmp('mission-work-reconciliation-test');
const manifestPath = nodePath.join(fixtureRoot, 'manifest.json');
const namespace = 'mission-work-reconciliation-test';
const actorId = 'reconciliation-test-actor';
const artifactPath = 'package.json';
const verificationPath = 'scripts/refactor/mission-distill.test.ts';
let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

function fileHash(repoRelativePath: string): string {
  return sha256(safeReadFile(pathResolver.rootResolve(repoRelativePath)) as Buffer);
}

function currentCommit(): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd: pathResolver.rootDir() }).trim();
}

function prepareMission(tasks?: Array<Record<string, unknown>>): void {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    nodePath.join(missionPath, 'mission-state.json'),
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status: 'validating',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: actorId,
        confidence_score: 1,
        git: {
          branch: 'test',
          start_commit: currentCommit(),
          latest_commit: currentCommit(),
          checkpoints: [],
        },
        history: [],
        context: {},
      },
      null,
      2
    )
  );
  safeWriteFile(
    nodePath.join(missionPath, 'NEXT_TASKS.json'),
    JSON.stringify(
      tasks || [
        {
          task_id: 'implementation',
          status: 'planned',
          description: 'Implement the reconciliation command.',
          acceptance_criteria: ['The reconciliation command updates only verified tasks.'],
          dependencies: [],
        },
        {
          task_id: 'repair-finish-exit',
          status: 'planned',
          description: 'Repair the finish exit gate.',
          acceptance_criteria: ['All pending tasks are resolved.'],
          dependencies: ['implementation'],
        },
      ],
      null,
      2
    )
  );
}

function buildManifest(
  overrides: Partial<MissionWorkReconciliationManifest> = {}
): MissionWorkReconciliationManifest {
  const commit = currentCommit();
  return {
    kind: 'mission-work-reconciliation',
    version: '1.0.0',
    mission_id: missionId,
    source: { repository: '.', branch: commit, commit },
    adopted_by: actorId,
    reason: 'Adopt implementation completed before work-item dispatch.',
    tasks: [
      {
        task_id: 'implementation',
        evidence: [
          { path: artifactPath, sha256: fileHash(artifactPath), kind: 'artifact' },
          {
            path: verificationPath,
            sha256: fileHash(verificationPath),
            kind: 'test_report',
          },
        ],
        criteria: [
          {
            criterion: 'The reconciliation command updates only verified tasks.',
            evidence_refs: [artifactPath],
          },
        ],
        verification: {
          command: 'pnpm vitest run scripts/refactor/mission-work-reconciliation.test.ts',
          status: 'passed',
          exit_code: 0,
          evidence_refs: [verificationPath],
        },
      },
    ],
    ...overrides,
  };
}

function writeManifest(manifest: MissionWorkReconciliationManifest): void {
  safeMkdir(fixtureRoot, { recursive: true });
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function prepareReviewReconciliationFixture(input?: {
  receiptHash?: string;
  reviewerAgentId?: string;
  artifactKind?: 'doc' | 'code';
}): MissionWorkReconciliationManifest {
  const sourceRepository = nodePath.join(fixtureRoot, 'review-source');
  safeMkdir(sourceRepository, { recursive: true });
  safeExec('git', ['init'], { cwd: sourceRepository });
  safeExec('git', ['config', 'user.email', 'review-test@example.invalid'], {
    cwd: sourceRepository,
  });
  safeExec('git', ['config', 'user.name', 'Review Test'], { cwd: sourceRepository });
  const reviewedArtifactPath = nodePath.join(sourceRepository, 'artifact.md');
  safeWriteFile(reviewedArtifactPath, '# Commit-bound reviewed artifact');
  const reviewedArtifactHash = sha256(safeReadFile(reviewedArtifactPath) as Buffer);
  const reviewerAgentId = input?.reviewerAgentId || 'independent-reviewer';
  safeWriteFile(
    nodePath.join(sourceRepository, 'review.json'),
    JSON.stringify(
      {
        kind: 'artifact-review-receipt',
        version: '1.0.0',
        review_id: 'review-content-r1',
        mission_id: missionId,
        review_task_id: 'review-content',
        review_target_task_id: 'implementation',
        artifact: {
          path: 'artifact.md',
          sha256: input?.receiptHash || reviewedArtifactHash,
          kind: input?.artifactKind || 'doc',
        },
        reviewer: {
          agent_id: reviewerAgentId,
          team_role: 'reviewer',
          specialist_roles: ['content-reviewer'],
          independent_from: ['implementation-agent'],
          independence_verified: true,
        },
        verdict: 'approved',
        findings: [],
        acceptance_criteria: ['The artifact has an independent content review.'],
        reviewed_at: '2026-07-13T00:00:00.000Z',
      },
      null,
      2
    )
  );
  safeExec('git', ['add', 'artifact.md', 'review.json'], { cwd: sourceRepository });
  safeExec('git', ['commit', '-m', 'add review fixture'], { cwd: sourceRepository });
  const commit = safeExec('git', ['rev-parse', 'HEAD'], { cwd: sourceRepository }).trim();
  prepareMission([
    {
      task_id: 'implementation',
      status: 'completed',
      description: 'Create the artifact.',
      acceptance_criteria: ['The artifact exists.'],
      assigned_to: { role: 'implementer', agent_id: 'implementation-agent' },
      dependencies: [],
    },
    {
      task_id: 'review-content',
      status: 'planned',
      description: 'Review the artifact content.',
      acceptance_criteria: ['The artifact has an independent content review.'],
      assigned_to: { role: 'reviewer', agent_id: reviewerAgentId },
      review_target: 'implementation',
      dependencies: ['implementation'],
    },
  ]);
  return {
    kind: 'mission-work-reconciliation',
    version: '1.0.0',
    mission_id: missionId,
    source: {
      repository: pathResolver.toRepoRelative(sourceRepository),
      branch: commit,
      commit,
    },
    adopted_by: actorId,
    reason: 'Adopt a commit-bound independent artifact review.',
    tasks: [
      {
        task_id: 'review-content',
        evidence: [
          {
            path: 'review.json',
            sha256: fileHash(
              pathResolver.toRepoRelative(nodePath.join(sourceRepository, 'review.json'))
            ),
            kind: 'review',
          },
        ],
        criteria: [
          {
            criterion: 'The artifact has an independent content review.',
            evidence_refs: ['review.json'],
          },
        ],
        verification: {
          command: 'review receipt validation',
          status: 'passed',
          exit_code: 0,
          evidence_refs: ['review.json'],
        },
      },
    ],
  };
}

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = actorId;
  setWorkCoordinationNamespace(namespace);
  safeRmSync(missionPath, { recursive: true, force: true });
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  safeRmSync(missionPath, { recursive: true, force: true });
  safeRmSync(fixtureRoot, { recursive: true, force: true });
  safeRmSync(pathResolver.shared(`runtime/work-coordination/${namespace}`), {
    recursive: true,
    force: true,
  });
  safeRmSync(pathResolver.shared(`observability/work-coordination/${namespace}`), {
    recursive: true,
    force: true,
  });
  clearWorkCoordinationNamespace();
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
});

describe('mission existing work reconciliation', () => {
  it('validates the canonical manifest example against the schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/mission-work-reconciliation.schema.json')
    );
    const example = JSON.parse(
      String(
        safeReadFile(
          pathResolver.knowledge('product/schemas/mission-work-reconciliation.example.json'),
          { encoding: 'utf8' }
        )
      )
    );

    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it('preflights without mutating mission tasks', async () => {
    prepareMission();
    writeManifest(buildManifest());

    const result = await reconcileMissionExistingWork({
      missionId,
      manifestPath,
      dryRun: true,
    });

    expect(result.status).toBe('dry_run_ready');
    const tasks = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    );
    expect(tasks[0].status).toBe('planned');
    expect(safeExistsSync(nodePath.join(missionPath, 'evidence', 'work-reconciliation'))).toBe(
      false
    );
  });

  it('completes verified tasks, resolves the finish repair task, and updates a linked work item', async () => {
    const workItem = importExternalWorkItem({
      source: 'local',
      sourceRef: `mission:${missionId}:implementation`,
      title: 'Existing implementation',
      description: 'Implementation completed outside dispatch.',
      status: 'ready',
      projectId: missionId,
      metadata: { mission_id: missionId, task_id: 'implementation' },
    });
    prepareMission([
      {
        task_id: 'implementation',
        status: 'planned',
        description: 'Implement the reconciliation command.',
        acceptance_criteria: ['The reconciliation command updates only verified tasks.'],
        dependencies: [],
        ticket_dispatch: { work_item_id: workItem.item_id },
      },
      {
        task_id: 'repair-finish-exit',
        status: 'planned',
        description: 'Repair the finish exit gate.',
        acceptance_criteria: ['All pending tasks are resolved.'],
        dependencies: ['implementation'],
      },
    ]);
    const statePath = nodePath.join(missionPath, 'mission-state.json');
    const state = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' })));
    state.git.latest_commit = 'stale-before-reconciliation';
    safeWriteFile(statePath, JSON.stringify(state, null, 2));
    writeManifest(buildManifest());

    const first = await reconcileMissionExistingWork({ missionId, manifestPath });
    const receiptPath = pathResolver.rootResolve(first.receipt_path!);
    const ledgerPath = nodePath.join(missionPath, 'execution-ledger.jsonl');
    const receiptBeforeRepeat = String(safeReadFile(receiptPath, { encoding: 'utf8' }));
    const ledgerBeforeRepeat = String(safeReadFile(ledgerPath, { encoding: 'utf8' }));
    const second = await reconcileMissionExistingWork({ missionId, manifestPath });

    expect(first.status).toBe('applied');
    expect(first.reconciled_task_ids).toEqual(['implementation']);
    expect(first.auto_completed_repair_task_ids).toEqual(['repair-finish-exit']);
    expect(first.work_item_ids_updated).toEqual([workItem.item_id]);
    expect(second.already_reconciled_task_ids).toEqual(['implementation']);
    expect(second.auto_completed_repair_task_ids).toEqual([]);
    expect(String(safeReadFile(receiptPath, { encoding: 'utf8' }))).toBe(receiptBeforeRepeat);
    expect(String(safeReadFile(ledgerPath, { encoding: 'utf8' }))).toBe(ledgerBeforeRepeat);
    const tasks = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    );
    expect(tasks.map((task: { status: string }) => task.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(tasks[0].reconciliation.manifest_sha256).toBe(first.manifest_sha256);
    const reconciledState = JSON.parse(String(safeReadFile(statePath, { encoding: 'utf8' })));
    expect(reconciledState.git.latest_commit).toBe(currentCommit());
    expect(getWorkItem(workItem.item_id)?.status).toBe('done');
    expect(first.receipt_path && safeExistsSync(pathResolver.rootResolve(first.receipt_path))).toBe(
      true
    );
  });

  it('rejects an artifact hash mismatch', async () => {
    prepareMission();
    const manifest = buildManifest();
    manifest.tasks[0].evidence[0].sha256 = '0'.repeat(64);
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('evidence hash mismatch');
  });

  it('rejects evidence that is not tracked by the source commit', async () => {
    prepareMission();
    const untrackedEvidencePath = nodePath.join(fixtureRoot, 'untracked-test-report.json');
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(untrackedEvidencePath, JSON.stringify({ status: 'passed' }));
    const untrackedRepoPath = pathResolver.toRepoRelative(untrackedEvidencePath);
    const manifest = buildManifest();
    manifest.tasks[0].evidence[1] = {
      path: untrackedRepoPath,
      sha256: sha256(safeReadFile(untrackedEvidencePath) as Buffer),
      kind: 'test_report',
    };
    manifest.tasks[0].verification.evidence_refs = [untrackedRepoPath];
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('evidence is not commit-bound');
  });

  it('rejects missing acceptance-criterion mappings', async () => {
    prepareMission();
    const manifest = buildManifest();
    manifest.tasks[0].criteria[0].criterion = 'Different criterion';
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('does not map acceptance criterion');
  });

  it('rejects a task whose dependency is neither terminal nor included', async () => {
    prepareMission([
      {
        task_id: 'requirements',
        status: 'planned',
        description: 'Define requirements.',
        acceptance_criteria: ['Requirements are defined.'],
        dependencies: [],
      },
      {
        task_id: 'implementation',
        status: 'planned',
        description: 'Implement the reconciliation command.',
        acceptance_criteria: ['The reconciliation command updates only verified tasks.'],
        dependencies: ['requirements'],
      },
    ]);
    writeManifest(buildManifest());

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('unresolved dependency requirements');
  });

  it('rejects an adopted_by identity that differs from the execution actor', async () => {
    prepareMission();
    writeManifest(buildManifest({ adopted_by: 'different-actor' }));

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('does not match execution actor');
  });

  it('rejects execution outside the mission-controller role', async () => {
    prepareMission();
    writeManifest(buildManifest());
    process.env.MISSION_ROLE = 'software_developer';

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('Mission controller authority is required');
  });

  it('adopts a commit-bound independent artifact review and persists its receipt in the mission', async () => {
    const manifest = prepareReviewReconciliationFixture();
    writeManifest(manifest);

    const result = await reconcileMissionExistingWork({ missionId, manifestPath });

    expect(result.reconciled_task_ids).toEqual(['review-content']);
    const tasks = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    );
    expect(tasks[1].status).toBe('completed');
    expect(tasks[1].artifact_review_profile.required_reviewer_roles).toContain('content-reviewer');
    expect(tasks[1].artifact_review_receipt).toMatch(/^evidence\/reviews\/reconciled-/u);
    expect(safeExistsSync(nodePath.join(missionPath, tasks[1].artifact_review_receipt))).toBe(true);
  });

  it('rejects a reconciled review whose receipt hash does not match the committed artifact', async () => {
    const manifest = prepareReviewReconciliationFixture({ receiptHash: '0'.repeat(64) });
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('invalidated by artifact change');
  });

  it('rejects a reconciled review performed by the implementation agent', async () => {
    const manifest = prepareReviewReconciliationFixture({
      reviewerAgentId: 'implementation-agent',
    });
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('performed by an implementation agent');
  });

  it('rejects a receipt whose declared artifact kind does not match the reviewed path', async () => {
    const manifest = prepareReviewReconciliationFixture({ artifactKind: 'code' });
    writeManifest(manifest);

    await expect(
      reconcileMissionExistingWork({ missionId, manifestPath, dryRun: true })
    ).rejects.toThrow('does not match inferred kind doc');
  });
});
