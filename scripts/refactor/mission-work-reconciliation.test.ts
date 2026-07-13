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
const verificationPath = 'scripts/refactor/mission-lifecycle.test.ts';
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
});
