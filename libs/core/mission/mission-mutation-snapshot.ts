/** Pins an approved owner operation to canonical mission/artifact bytes. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { findMissionPath } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeReadFileSnapshot, safeLstat } from '../secure-io.js';
import { withLock } from '../foundation/lock-utils.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { readMissionStateAtPath } from './mission-state-reader.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Expectation = {
  missionId: string;
  operation: string;
  taskId?: string;
  hash: string;
  held: boolean;
  checked: boolean;
};
const expectations = new AsyncLocalStorage<Expectation>();

export function missionMutationSnapshot(
  missionId: string,
  operation: string,
  taskId?: string,
  state?: unknown
): string {
  const directory = findMissionPath(missionId);
  if (!directory) throw new Error('[MCP_MISSION_OWNER_REQUIRED] Mission directory is unavailable');
  const boardPath = path.join(directory, 'NEXT_TASKS.json');
  let reviewedArtifact: string | undefined;
  if (operation === 'review_task') {
    const board = loadMissionNextTaskObjectsAtPath(boardPath, missionId);
    const review = board?.find((task) => task.task_id === taskId);
    const target = board?.find((task) => task.task_id === review?.review_target);
    const reference = target?.deliverable || target?.target_path;
    if (!review || typeof reference !== 'string')
      throw new Error(
        '[MCP_MISSION_REVIEW_TARGET_REQUIRED] Review must name an existing target artifact'
      );
    const artifact = path.resolve(directory, reference);
    if (!artifact.startsWith(path.resolve(directory) + path.sep))
      throw new Error('[MCP_MISSION_REVIEW_TARGET_REQUIRED] Review target is outside its mission');
    const safe = assertSafeRepositoryPath(artifact);
    if (!safeLstat(safe).isFile())
      throw new Error('[MCP_MISSION_REVIEW_TARGET_REQUIRED] Review target must be a regular file');
    reviewedArtifact = digest(safeReadFileSnapshot(safe, 16_777_216));
  }
  const currentState = state ?? readMissionStateAtPath(path.join(directory, 'mission-state.json'));
  return digest(
    JSON.stringify({
      state: currentState,
      board: digest(safeReadFileSnapshot(boardPath, 16_777_216)),
      reviewedArtifact,
    })
  );
}

export function assertMissionSnapshotExpectation(missionId: string): void {
  const expected = expectations.getStore();
  if (!expected || expected.missionId !== missionId.toUpperCase() || expected.checked) return;
  if (
    missionMutationSnapshot(expected.missionId, expected.operation, expected.taskId) !==
    expected.hash
  )
    throw new Error(
      '[MCP_MISSION_STALE_APPROVAL] Mission or reviewed artifact changed; request fresh approval'
    );
  expected.checked = true;
}

/** Only true in the async callback which acquired this exact mission lock. */
export function holdsMissionMutationLock(missionId: string): boolean {
  const expected = expectations.getStore();
  return Boolean(expected?.held && expected.missionId === missionId.toUpperCase());
}

export async function withMissionMutationExpectation<T>(
  input: { missionId: string; operation: string; taskId?: string; hash: string },
  run: () => Promise<T>
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(input.hash))
    throw new Error('[MCP_MISSION_SNAPSHOT_INVALID] Invalid expected snapshot');
  const context: Expectation = {
    ...input,
    missionId: input.missionId.toUpperCase(),
    held: false,
    checked: false,
  };
  return expectations.run(context, async () => {
    if (['verify', 'distill', 'finish'].includes(input.operation))
      return withLock(`mission-${context.missionId}`, async () => {
        context.held = true;
        try {
          assertMissionSnapshotExpectation(context.missionId);
          return await run();
        } finally {
          context.held = false;
        }
      });
    return run();
  });
}
