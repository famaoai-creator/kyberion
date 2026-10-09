import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import {
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from '../managed-process.js';
import {
  seedFirstJobTestRoot,
  FIRST_JOB_TEST_SESSION_KEY,
} from '../../../scripts/fixtures/first-job-approval-fixture.js';

const sourceRoot = process.cwd();
// Lock names encode the fixture root: compact random IDs keep each filename
// below NAME_MAX even when the checkout itself is a deeply nested worktree.
const fixtureId = () => randomBytes(6).toString('hex');
const rootBase = path.join(sourceRoot, 'active/shared/tmp', 'recovery-engine-' + fixtureId());
let root: string;
const children: ManagedProcessHandle[] = [];
// Each run() starts fresh `node --import ts-loader` children, and every cold
// start transpiles the libs/core graph the worker imports (about 5s of CPU,
// 10s on a loaded 4-vCPU host) before the fixture does any work. The longest
// test runs 17 sequential child batches, so a 180s local budget failed on a
// busy machine while CI (CI=true, 600s) stayed green. A hung child is still
// caught by the per-child timer in start(); this is only the backstop.
const CHILD_TIMEOUT_MS = process.env.CI ? 120000 : 60000;
const ENGINE_TEST_TIMEOUT_MS = 600000;
type EngineValue = {
  preparationError?: string;
  strictRecovery: { ok: boolean; reason?: string };
  childArtifactAbsent: boolean;
  childOutputAbsent: boolean;
  childResults: number;
  before: import('./first-job-recovery.js').FirstJobRecoveryView[];
  after: import('./first-job-recovery.js').FirstJobRecoveryView[];
  result: { ok: true; status: string };
  ready?: boolean;
  isolated?: boolean;
  version: number;
  workItem: import('../workforce/work-coordination-types.js').WorkItem | null;
  request: import('./front-desk-conversation-persistence.js').FrontDeskExecutionRequest;
  originalApprovalUnchanged: boolean;
  actionRows: import('../dot/dot-action-ledger.js').DotActionRecord[];
  work: import('./front-desk-conversation-history.js').FrontDeskConversationWork;
  witness: Array<{ phase: string; process: string }>;
  proofValid: boolean;
  parent: import('./front-desk-execution-contract.js').FrontDeskExecutionBinding;
  parentSha: string;
  parentBody: string;
  oldAdmission: { ok: boolean };
  requests: Array<{
    binding: import('./front-desk-execution-contract.js').FrontDeskExecutionBinding;
    status: string;
    admission: boolean;
    actionCount: number;
    workItem: unknown;
    artifactPath: string;
  }>;
  parentArtifact: import('./front-desk-conversation-history.js').FrontDeskConversationWorkArtifact & {
    body: string;
  };
  history: import('./front-desk-conversation-history.js').ConversationHistory;
};
type Result = {
  ok: boolean;
  error?: string;
  value?: EngineValue;
  exit?: number;
  crashed?: boolean;
};
function start(
  mode: string,
  options: { cwd?: string; configuredRoot?: string; expectGuardRefusal?: boolean } = {}
) {
  const handle = spawnManagedProcess({
    resourceId: 'recovery-engine-child-' + randomUUID(),
    kind: 'service',
    ownerId: 'recovery-engine-fixture',
    ownerType: 'test',
    command: process.execPath,
    args: [
      '--import',
      path.join(sourceRoot, 'scripts/ts-loader.mjs'),
      path.join(sourceRoot, 'libs/core/surface/__tests__/parked-recovery-engine-worker.ts'),
      mode,
    ],
    spawnOptions: {
      cwd: options.cwd ?? root,
      env: {
        ...process.env,
        KYBERION_ROOT: options.configuredRoot ?? root,
        KYBERION_SESSION_SECRET:
          mode === 'facade-smoke'
            ? FIRST_JOB_TEST_SESSION_KEY + '-rotated-browser'
            : ['proof-valid', 'stale-lineage'].includes(mode)
              ? FIRST_JOB_TEST_SESSION_KEY
              : '',
        KYBERION_OIDC_ISSUER: 'https://fixture.example',
        KYBERION_OIDC_CLIENT_ID: 'fixture',
        MISSION_ID: '',
        MISSION_ROLE: 'worker',
        KYBERION_PERSONA: 'worker',
        KYBERION_TENANT: '',
        KYBERION_ORGANIZATION: '',
        KYBERION_PROJECT_ID: '',
        KYBERION_REASONING_BACKEND: 'stub',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  });
  children.push(handle);
  let stdout = '';
  let stderr = '';
  let crashObserved = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const result = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('child timed out: ' + stderr + stdout);
      readyReject(error);
      reject(error);
      stopManagedProcess(handle.resourceId, handle.child);
    }, CHILD_TIMEOUT_MS);
    handle.child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) readyResolve();
      if (mode === 'crash' && !crashObserved && stdout.includes('CRASH_AFTER_TOMBSTONE\n')) {
        crashObserved = true;
        stopManagedProcess(handle.resourceId, handle.child);
      }
    });
    handle.child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    handle.child.once('error', (error) => {
      clearTimeout(timer);
      readyReject(error);
      reject(error);
    });
    handle.child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (options.expectGuardRefusal) {
        readyResolve();
        resolve({
          ok: false,
          exit: code ?? undefined,
          error: stderr,
          value: { ready: stdout.includes('READY\n') } as EngineValue,
        });
        return;
      }
      if (crashObserved && mode === 'crash' && (signal || code !== 0)) {
        resolve({ ok: true, crashed: true });
        return;
      }
      const line = stdout
        .split('\n')
        .reverse()
        .find((line) => line.startsWith('{"ok":'));
      if (!line) {
        const error = new Error('missing child result: ' + code + ': ' + stderr + stdout);
        readyReject(error);
        reject(error);
        return;
      }
      resolve(JSON.parse(line));
    });
  });
  void result.catch(() => undefined);
  return { handle, ready, result };
}
async function run(...modes: string[]): Promise<Result[]> {
  const pending = modes.map((mode) => start(mode));
  await Promise.all(pending.map((child) => child.ready));
  for (const child of pending) child.handle.child.stdin?.end('go\n');
  return Promise.all(pending.map((child) => child.result));
}
beforeEach(() => {
  root = path.join(rootBase, fixtureId());
  seedFirstJobTestRoot(sourceRoot, root);
}, 60000);
afterAll(async () => {
  // A child left running by a timed-out test may still be writing into its
  // fixture root: wait for every child to exit before removing the tree.
  const exited = children.map(
    ({ child }) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', () => resolve());
      })
  );
  for (const child of children) stopManagedProcess(child.resourceId, child.child);
  await Promise.all(exited);
  safeRmSync(rootBase, { recursive: true, force: true });
}, 60000);

describe('real-process parked recovery fences and restart', () => {
  it(
    'keeps stale parent lineage behind the executor pre-effect barrier and rejects recovery once an item exists',
    async () => {
      const actual = (await run('stale-lineage'))[0];
      expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true });
      expect(actual.value).toMatchObject({
        proofValid: true,
        workItem: { status: 'ready' },
        preparationError: expect.stringContaining('parent_artifact_unverified'),
        strictRecovery: { ok: false, reason: 'historical_dispatch_evidence' },
        childArtifactAbsent: true,
        childOutputAbsent: true,
        childResults: 0,
        originalApprovalUnchanged: true,
      });
    },
    ENGINE_TEST_TIMEOUT_MS
  );

  it(
    'runs real browser authentication and the recovery facade against retained stores',
    async () => {
      const actual = (await run('facade-smoke'))[0];
      expect(actual, JSON.stringify(actual)).toMatchObject({ ok: true });
      expect(actual.value.before).toHaveLength(1);
      expect(actual.value.before[0].status).toBe('eligible');
      expect(actual.value.result).toMatchObject({ ok: true, status: 'terminated_unstarted' });
      expect(actual.value.after).toHaveLength(1);
      expect(actual.value.after[0].status).toBe('terminated_unstarted');
      expect(actual.value.originalApprovalUnchanged).toBe(true);
      expect(actual.value.workItem).toBeNull();
    },
    ENGINE_TEST_TIMEOUT_MS
  );

  it(
    'requires the exact isolated root and known command before READY',
    async () => {
      const mismatch = await start('unknown-mode', {
        configuredRoot: rootBase,
        expectGuardRefusal: true,
      }).result;
      expect(mismatch.exit).not.toBe(0);
      expect(mismatch.error).toContain('isolated recovery-engine test root required');
      expect(mismatch.value.ready).toBe(false);
      const wrongShape = await start('unknown-mode', {
        cwd: rootBase,
        configuredRoot: rootBase,
        expectGuardRefusal: true,
      }).result;
      expect(wrongShape.exit).not.toBe(0);
      expect(wrongShape.error).toContain('isolated recovery-engine test root required');
      expect(wrongShape.value.ready).toBe(false);
      const unknownCommand = await start('unknown-mode', { expectGuardRefusal: true }).result;
      expect(unknownCommand.exit).not.toBe(0);
      expect(unknownCommand.error).toContain('unknown recovery-engine fixture command');
      expect(unknownCommand.value.ready).toBe(false);
      expect((await run('validate-root'))[0]).toMatchObject({
        ok: true,
        value: { isolated: true },
      });
    },
    ENGINE_TEST_TIMEOUT_MS
  );

  it(
    'survives a killed tombstone writer, stale settlement and two simultaneous human retries without dispatch',
    async () => {
      const seed = (await run('seed'))[0];
      expect(seed, JSON.stringify(seed)).toMatchObject({ ok: true });
      const before = (await run('read'))[0];
      expect(before.value.version).toBe(3);
      expect((await run('new'))[0].ok).toBe(false);
      const witnesses = await run('witness-a', 'witness-b');
      expect(
        witnesses.every((result) => result.ok),
        JSON.stringify(witnesses)
      ).toBe(true);
      const complete = witnesses.find((result) => result.value.witness.length === 4)!.value.witness;
      expect(complete.map((row) => row.phase)).toEqual(['begin', 'end', 'begin', 'end']);
      expect(complete[0].process).toBe(complete[1].process);
      expect(complete[2].process).toBe(complete[3].process);
      expect((await run('crash'))[0]).toEqual({ ok: true, crashed: true });
      const partial = (await run('settle'))[0];
      expect(partial, JSON.stringify(partial)).toMatchObject({ ok: true });
      expect(partial.value).toMatchObject({
        version: 5,
        workItem: null,
        originalApprovalUnchanged: true,
        request: { status: 'terminated_unstarted' },
        actionRows: [{ status: 'parked' }],
      });
      expect(partial.value.work.tasks[0].executionStatus).toBe('uncertain');
      expect((await run('new'))[0].ok).toBe(false);
      const recovered = await run('recover', 'recover', 'settle');
      expect(
        recovered.every((result) => result.ok),
        JSON.stringify(recovered)
      ).toBe(true);
      const final = (await run('followup'))[0];
      expect(final, JSON.stringify(final)).toMatchObject({ ok: true });
      expect(final.value).toMatchObject({
        version: 5,
        workItem: null,
        originalApprovalUnchanged: true,
        request: { status: 'terminated_unstarted', revision: 1 },
      });
      expect(final.value.actionRows).toHaveLength(2);
      expect(final.value.actionRows[1]).toMatchObject({
        status: 'declined',
        reason: 'terminated_unstarted',
        recovery_receipt: partial.value.request.recoveryReceipt,
      });
      expect(final.value.work.tasks[0]).toMatchObject({
        executionStatus: 'terminated_unstarted',
        turnState: 'settled',
      });
      expect(final.value.work.tasks[0].artifact).toBeUndefined();
      expect(final.value.request.recoveryReceipt).toEqual(partial.value.request.recoveryReceipt);
      const validProof = (await run('proof-valid'))[0];
      expect(validProof.value.proofValid).toBe(true);
      expect(validProof.value.work.tasks[0].executionStatus).toBe('terminated_unstarted');
      expect(validProof.value.workItem).toBeNull();
      expect((await run('ambiguous'))[0].value.work.tasks[0].executionStatus).toBe('uncertain');
      expect((await run('new'))[0].ok).toBe(false);
      expect((await run('restore-actions'))[0].value.work.tasks[0].executionStatus).toBe(
        'terminated_unstarted'
      );
      expect((await run('pause'))[0].value.work.tasks[0].executionStatus).toBe('uncertain');
      expect((await run('new'))[0].ok).toBe(false);
      expect((await run('activate'))[0].value.work.tasks[0].executionStatus).toBe(
        'terminated_unstarted'
      );
      expect(
        (await run('new'))[0],
        'only a separate explicit new UUID can now reserve new work'
      ).toMatchObject({ ok: true });
    },
    ENGINE_TEST_TIMEOUT_MS
  );
  it(
    'admits one distinct revision only after the old child is strictly terminal, preserving verified parent bytes',
    async () => {
      const seeded = (await run('seed-revision'))[0];
      expect(seeded, JSON.stringify(seeded)).toMatchObject({ ok: true });
      expect((await run('revision-a'))[0].ok).toBe(false);
      expect((await run('crash'))[0]).toEqual({ ok: true, crashed: true });
      expect((await run('revision-a'))[0].ok).toBe(false);
      const raced = await run('recover', 'revision-a', 'revision-b');
      expect(raced[0], JSON.stringify(raced)).toMatchObject({ ok: true });
      expect(raced.slice(1).filter((row) => row.ok).length).toBeLessThanOrEqual(1);
      if (!raced.slice(1).some((row) => row.ok))
        expect((await run('revision-a'))[0]).toMatchObject({ ok: true });
      const result = (await run('settle'))[0];
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const value = result.value;
      expect(value.request).toMatchObject({ status: 'terminated_unstarted', revision: 2 });
      expect(value.oldAdmission.ok).toBe(false);
      expect(value.workItem).toBeNull();
      expect(value.actionRows).toHaveLength(2);
      const siblings = value.requests.filter(
        (row) => row.binding.parent_request_id === seeded.value.parent.request_id
      );
      expect(siblings).toHaveLength(2);
      const live = siblings.filter((row) => row.status !== 'terminated_unstarted');
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        status: 'pending',
        admission: true,
        actionCount: 0,
        workItem: null,
      });
      expect(live[0].binding.request_id).not.toBe(value.request.binding.request_id);
      expect(live[0].binding.work_item_id).not.toBe(value.request.binding.work_item_id);
      expect(live[0].binding.revision).toBe(2);
      expect(live[0].binding.parent_sha256).toBe(seeded.value.parentSha);
      expect(new Set(siblings.map((row) => row.artifactPath)).size).toBe(2);
      expect(value.parentArtifact).toMatchObject({
        body: seeded.value.parentBody,
        sha256: seeded.value.parentSha,
        verification: 'verified',
        currentness: 'latest_verified',
      });
      expect(
        value.work.tasks.find((row) => row.id === seeded.value.parent.request_id).artifact
          .currentness
      ).toBe('latest_verified');
      expect(
        value.history.messages.find(
          (row) => row.artifact?.requestId === seeded.value.parent.request_id
        ).artifact.canRevise
      ).toBe(false);
      const other = live[0].binding.request_id.endsWith('3') ? 'revision-b' : 'revision-a';
      expect((await run(other))[0].ok).toBe(false);
      const final = (await run('read'))[0].value;
      expect(final.requests).toHaveLength(3);
      expect(final.request.recoveryReceipt).toEqual(value.request.recoveryReceipt);
      expect(final.parentArtifact.body).toBe(seeded.value.parentBody);
      expect(final.originalApprovalUnchanged).toBe(true);
    },
    ENGINE_TEST_TIMEOUT_MS
  );
});
