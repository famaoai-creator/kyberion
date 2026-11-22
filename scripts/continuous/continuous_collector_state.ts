import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dotStatePath } from '@agent/core/dot/dot-state-paths';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { nowIso } from '@agent/core/foundation/time';
import { withLock } from '@agent/core/foundation/lock-utils';
import { readJson, writeJson } from '@agent/core/foundation/json';
import { safeExistsSync, safeRealpath } from '@agent/core/secure-io';
import {
  isContinuousProcessStopped,
  type ContinuousProcessContainment,
} from './continuous_owner_platform.js';

type Attempt = {
  attempt_id: string;
  pipeline_ref: string;
  pipeline_run_id?: string;
  started_at: string;
  status: 'unconfirmed' | 'not_started' | 'completed' | 'reconciled';
  containment_required?: true;
  containment?: ContinuousProcessContainment;
  stop_confirmed_at?: string;
  reason_code?: CollectorNotStartedReason;
  reconciliation?: { evidence: string; approval_id: string; reconciled_at: string };
};
export class CollectorUnavailable extends Error {}
export const COLLECTOR_NOT_STARTED_NEXT = {
  worker_missing: 'Build the repository and check the collector worker artifact.',
  deadline_elapsed: 'Check the charter wall-clock budget and earlier collectors.',
  authorization_changed: 'Check the active organization, charter and operations halt.',
  spawn_rejected: 'Check local process launch permissions and the Node executable.',
  pipeline_preflight_failed: 'Check the reviewed Pipeline path, ADF and execution prerequisites.',
} as const;
export type CollectorNotStartedReason = keyof typeof COLLECTOR_NOT_STARTED_NEXT;
export class CollectorNotStarted extends CollectorUnavailable {
  constructor(readonly reason: CollectorNotStartedReason) {
    super(COLLECTOR_NOT_STARTED_NEXT[reason]);
  }
}
export const COLLECTOR_NOT_STARTED_EXIT = 20;

function identity(root: string, charter: Pick<DotCharter, 'scope'>, ref: string) {
  const digest = createHash('sha256').update(ref).digest('hex');
  const file = path.join(root, dotStatePath(charter, `continuous-collector-${digest}.json`));
  return { file, lock: 'continuous-collector:' + file };
}

export function readCollectorAttempt(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string
) {
  const { file } = identity(root, charter, ref);
  let existing = file;
  while (!safeExistsSync(existing)) existing = path.dirname(existing);
  if (safeRealpath(existing) !== path.resolve(safeRealpath(root), path.relative(root, existing)))
    throw new CollectorUnavailable('Collector state path cannot traverse symlinks');
  if (existing !== file) return null;
  const attempt = readJson<Attempt>(file, { maxSizeMB: 1 });
  if (
    !attempt ||
    attempt.pipeline_ref !== ref ||
    (attempt.pipeline_run_id !== undefined && attempt.pipeline_run_id !== attempt.attempt_id) ||
    typeof attempt.attempt_id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(attempt.attempt_id) ||
    !Number.isFinite(Date.parse(attempt.started_at)) ||
    (attempt.stop_confirmed_at !== undefined &&
      (typeof attempt.stop_confirmed_at !== 'string' ||
        !Number.isFinite(Date.parse(attempt.stop_confirmed_at)))) ||
    (attempt.containment_required !== undefined && attempt.containment_required !== true) ||
    (attempt.containment !== undefined &&
      (!attempt.containment ||
        typeof attempt.containment.host !== 'string' ||
        !Number.isSafeInteger(attempt.containment.pid) ||
        attempt.containment.pid <= 0 ||
        !['posix_group', 'windows_job'].includes(attempt.containment.kind))) ||
    (attempt.reason_code !== undefined &&
      !Object.hasOwn(COLLECTOR_NOT_STARTED_NEXT, attempt.reason_code)) ||
    !['unconfirmed', 'not_started', 'completed', 'reconciled'].includes(attempt.status) ||
    (attempt.status === 'reconciled' &&
      (typeof attempt.reconciliation?.evidence !== 'string' ||
        typeof attempt.reconciliation.approval_id !== 'string' ||
        !Number.isFinite(Date.parse(attempt.reconciliation.reconciled_at))))
  )
    throw new CollectorUnavailable('Invalid collector attempt receipt');
  return attempt;
}

/** Manual and scheduled paths share this lock and record the attempt before starting effects. */
export async function withCollectorAttempt(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string,
  assertCurrent: () => void,
  run: (
    attemptId: string,
    register: (process: ContinuousProcessContainment) => void
  ) => Promise<void>,
  capture?: (attemptId: string) => void
): Promise<void> {
  const { file, lock } = identity(root, charter, ref);
  const seen = readCollectorAttempt(root, charter, ref);
  await withLock(
    lock,
    async () => {
      const prior = readCollectorAttempt(root, charter, ref);
      if (prior?.status === 'unconfirmed')
        throw new CollectorUnavailable(
          `Collector attempt ${prior.attempt_id} requires reconciliation`
        );
      if (prior?.attempt_id !== seen?.attempt_id || prior?.status !== seen?.status)
        throw new CollectorUnavailable('Collector attempt changed while waiting for execution');
      if (prior?.containment && !prior.stop_confirmed_at)
        writeJson(file, confirmCollectorStop(prior));
      assertCurrent();
      const id = randomUUID();
      const attempt: Attempt = {
        attempt_id: id,
        pipeline_run_id: id,
        pipeline_ref: ref,
        started_at: nowIso(),
        status: 'unconfirmed',
        containment_required: true,
      };
      writeJson(file, attempt);
      try {
        await run(id, (containment) => {
          writeJson(file, { ...attempt, containment });
          attempt.containment = containment;
        });
      } catch (error) {
        if (error instanceof CollectorNotStarted) {
          writeJson(file, { ...attempt, status: 'not_started', reason_code: error.reason });
          throw error;
        }
        throw new CollectorUnavailable(
          `Collector attempt ${attempt.attempt_id} has no confirmed result`
        );
      }
      const completed: Attempt = { ...attempt, status: 'completed' };
      writeJson(file, completed);
      writeJson(file, confirmCollectorStop(completed));
      assertCurrent();
      capture?.(id);
    },
    1000
  );
}

export async function readCollectorSnapshot(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string,
  capture: (attemptId: string) => void
): Promise<void> {
  const { lock } = identity(root, charter, ref);
  await withLock(
    lock,
    async () => {
      const attempt = readCollectorAttempt(root, charter, ref);
      if (attempt?.status !== 'completed' || !attempt.pipeline_run_id)
        throw new CollectorUnavailable('Collector has no confirmed observation attempt');
      assertCollectorProcessStopped(attempt);
      capture(attempt.pipeline_run_id);
    },
    1000
  );
}

function assertCollectorProcessStopped(attempt: Attempt): void {
  if (attempt.stop_confirmed_at) return;
  // Without registration a new worker cannot pass the execution fence.
  // Old unconfirmed receipts have no such guarantee.
  if (
    attempt.containment
      ? !isContinuousProcessStopped(attempt.containment)
      : !attempt.containment_required
  )
    throw new CollectorUnavailable('Cannot confirm the previous collector process has stopped');
}

function confirmCollectorStop(attempt: Attempt): Attempt {
  if (attempt.stop_confirmed_at) return attempt;
  assertCollectorProcessStopped(attempt);
  return { ...attempt, stop_confirmed_at: nowIso() };
}

async function withUnconfirmedCollectorAttempt(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string,
  attemptId: string,
  update: (attempt: Attempt, store: (next: Attempt) => void) => void
): Promise<void> {
  const { file, lock } = identity(root, charter, ref);
  await withLock(
    lock,
    async () => {
      const current = readCollectorAttempt(root, charter, ref);
      if (current?.attempt_id !== attemptId || current.status !== 'unconfirmed')
        throw new Error('The specified collector attempt is no longer awaiting reconciliation');
      update(current, (next) => writeJson(file, next));
    },
    1000
  );
}

export async function recordCollectorStop(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string,
  attemptId: string
): Promise<void> {
  await withUnconfirmedCollectorAttempt(root, charter, ref, attemptId, (current, store) => {
    if (!current.stop_confirmed_at) store(confirmCollectorStop(current));
  });
}

export async function reconcileCollectorAttempt(
  root: string,
  charter: Pick<DotCharter, 'scope'>,
  ref: string,
  attemptId: string,
  evidence: string,
  approvalId: string,
  authorize: (commit: () => void) => void
): Promise<void> {
  await withUnconfirmedCollectorAttempt(root, charter, ref, attemptId, (current, store) => {
    const stopped = confirmCollectorStop(current);
    authorize(() =>
      store({
        ...stopped,
        status: 'reconciled',
        reconciliation: {
          evidence,
          approval_id: approvalId,
          reconciled_at: nowIso(),
        },
      })
    );
  });
}
