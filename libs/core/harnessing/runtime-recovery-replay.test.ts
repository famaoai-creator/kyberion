import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeRealpath,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';

const cleanup: string[] = [];
afterEach(() => {
  withExecutionContext('mission_controller', () => {
    for (const directory of cleanup.splice(0)) safeRmSync(directory);
  });
});

/** Fresh OS processes use the real stores; only the interruption point is synthetic. */
function fixture() {
  const root = pathResolver.sharedTmp(`public/shared/runtime-recovery-${randomUUID()}`);
  safeMkdir(root, { recursive: true });
  cleanup.push(root);
  const source = (module: string) =>
    JSON.stringify(pathToFileURL(pathResolver.rootResolve(`libs/core/${module}.ts`)).href);
  const run = (name: string, body: string) => {
    const script = path.join(root, `${name}.mjs`);
    safeWriteFile(script, body);
    return safeExecResult(
      process.execPath,
      ['--import', pathResolver.rootResolve('scripts/ts-loader.mjs'), script],
      {
        cwd: pathResolver.rootDir(),
        env: { MISSION_ROLE: 'mission_controller', KYBERION_PERSONA: 'mission_controller' },
        timeoutMs: 20_000,
        maxOutputMB: 1,
      }
    );
  };
  const success = (name: string, body: string) => {
    const result = run(name, body);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const killed = (name: string, body: string) => {
    const marker = path.join(root, `${name}.boundary`);
    const result = run(
      name,
      `import { safeWriteFile as mark } from ${source('secure-io')};\n${body}\n` +
        `mark(${JSON.stringify(marker)}, 'persisted');\nprocess.kill(process.pid, 'SIGKILL');`
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBeNull();
    expect(String(safeReadFile(marker))).toBe('persisted');
  };
  return { root, source, success, killed };
}

describe('runtime recovery replay across abrupt process termination', () => {
  it.each(['inflight', 'completed'] as const)(
    'does not grant a second callback claim after %s OAuth process termination',
    (phase) => {
      const f = fixture();
      const serviceId = `recovery-${randomUUID()}`;
      cleanup.push(pathResolver.sharedTmp(`oauth/${serviceId}`));
      const now = Date.now();
      const session = {
        serviceId,
        state: 'recovery_state_1234',
        operationId: 'recovery_operation_1234',
        observerPrincipalId: 'recovery-operator',
        scopes: ['read'],
        codeVerifier: 'fixture-verifier',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
      };
      f.killed(
        'oauth-interrupted',
        `import { savePendingOAuthSession, acquirePendingOAuthCallback, finishOAuthOperation } from ${f.source('oauth-session-store')};
         const session = ${JSON.stringify(session)};
         savePendingOAuthSession(session);
         const claim = acquirePendingOAuthCallback(session.serviceId, session.state, ${now});
         if (!claim) throw new Error('fixture callback claim missing');
         ${phase === 'completed' ? `finishOAuthOperation(claim.session, 'connected', ${now + 1});` : ''}`
      );
      f.success(
        'oauth-restarted',
        `import assert from 'node:assert/strict';
         import { acquirePendingOAuthCallback, readOAuthOperation, serviceSessionPath } from ${f.source('oauth-session-store')};
         import { safeExistsSync } from ${f.source('secure-io')};
         const session = ${JSON.stringify(session)};
         // A callback can reach token exchange only after this existing claim seam.
         assert.equal(acquirePendingOAuthCallback(session.serviceId, session.state, ${now + 2}), null);
         assert.equal(readOAuthOperation(session.serviceId, session.operationId, 'other', ${now + 2}), null);
         assert.equal(readOAuthOperation(session.serviceId, session.operationId, session.observerPrincipalId, ${now + 2})?.status, '${phase === 'completed' ? 'connected' : 'confirming'}');
         ${
           phase === 'inflight'
             ? `assert.equal(readOAuthOperation(session.serviceId, session.operationId, session.observerPrincipalId, ${now + 120_001})?.status, 'expired');
                assert.equal(acquirePendingOAuthCallback(session.serviceId, session.state, ${now + 120_002}), null);`
             : ''
         }
         assert.equal(safeExistsSync(serviceSessionPath(session.serviceId, session.state)), false);`
      );
    },
    45_000
  );

  it('recovers a prepared plugin publication after termination and repeats recovery without changing bytes', () => {
    const f = fixture();
    const logicalTarget = path.join(f.root, 'managed', 'plugin');
    safeMkdir(path.dirname(logicalTarget), { recursive: true });
    const target = path.join(
      safeRealpath(path.dirname(logicalTarget)),
      path.basename(logicalTarget)
    );
    const key =
      process.platform === 'darwin' || process.platform === 'win32' ? target.toLowerCase() : target;
    const transaction = path.join(
      path.dirname(target),
      '.kyberion-publications',
      createHash('sha256').update(key).digest('hex')
    );
    f.killed(
      'plugin-interrupted',
      `import { createHash } from 'node:crypto';
       import { safeMkdir, safeWriteFile, safeMoveSync } from ${f.source('secure-io')};
       const target = ${JSON.stringify(target)}, transaction = ${JSON.stringify(transaction)};
       safeMkdir(target, { recursive: true });
       safeWriteFile(target + '/code.txt', 'previous-code-and-approval');
       safeMkdir(transaction + '/candidate', { recursive: true });
       safeWriteFile(transaction + '/candidate/code.txt', 'new-unapproved-code');
       const digest = text => createHash('sha256').update(text).digest('hex');
       // Inject the documented durable boundary: prepared journal, old tree moved,
       // candidate not yet published. No exception unwinding/rollback can run.
       safeWriteFile(transaction + '/journal.json', JSON.stringify({ version: 1, phase: 'prepared', old: digest('previous-code-and-approval'), next: digest('new-unapproved-code') }));
       safeMoveSync(target, transaction + '/previous');`
    );
    f.success(
      'plugin-restarted',
      `import assert from 'node:assert/strict';
       import { createHash } from 'node:crypto';
       import { recoverPluginPublication, withPluginPublicationLock } from ${f.source('plugin/plugin-publication')};
       import { safeReadFile, safeExistsSync } from ${f.source('secure-io')};
       const target = ${JSON.stringify(target)};
       const fingerprint = dir => createHash('sha256').update(String(safeReadFile(dir + '/code.txt'))).digest('hex');
       for (let i = 0; i < 2; i++) withPluginPublicationLock(target, () => recoverPluginPublication(target, fingerprint));
       assert.equal(String(safeReadFile(target + '/code.txt')), 'previous-code-and-approval');
       assert.equal(safeExistsSync(${JSON.stringify(transaction)}), false);`
    );
  }, 45_000);

  it('restores a committed compaction in a fresh process without appending or replaying tool effects', () => {
    const f = fixture();
    const missionId = `MSN-RECOVERY-FIXTURE-${randomUUID()}`.toUpperCase();
    const missionDir = pathResolver.missionDir(missionId, 'public');
    cleanup.push(missionDir);
    const scope = { tier: 'public', mission_id: missionId, task_id: 'restore-task' };
    const now = Date.now();
    const journalPath = path.join(f.root, 'worker.jsonl');
    const messages = [
      { role: 'user', content: 'current goal', pinned: true },
      { role: 'tool_use', content: 'historical tool request; never re-execute' },
      { role: 'tool_result', content: 'historical effect already delivered' },
    ];
    f.killed(
      'compaction-interrupted',
      `import { safeMkdir, safeWriteFile } from ${f.source('secure-io')};
       import { writeCompactionSnapshot } from ${f.source('workforce/worker-compaction-snapshot')};
       import { WorkerStateJournal } from ${f.source('workforce/worker-state-journal')};
       // A synthetic owner fixture, never a real mission lifecycle mutation.
       safeMkdir(${JSON.stringify(missionDir)}, { recursive: true });
       safeWriteFile(${JSON.stringify(path.join(missionDir, 'mission-state.json'))}, JSON.stringify({
         mission_id: ${JSON.stringify(missionId)}, tier: 'public', status: 'active', execution_mode: 'local',
         priority: 1, assigned_persona: 'worker', confidence_score: 1,
         git: { branch: 'fixture', start_commit: 'a', latest_commit: 'a', checkpoints: [] }, history: []
       }));
       const messages = ${JSON.stringify(messages)};
       const receipt = await writeCompactionSnapshot({ source: messages, messages, scope: ${JSON.stringify(scope)}, retentionMs: 60_000, now: ${now} });
       new WorkerStateJournal({ journalPath: ${JSON.stringify(journalPath)} }).recordCompaction(receipt);`
    );
    const journalBefore = String(safeReadFile(journalPath));
    f.success(
      'compaction-restarted',
      `import assert from 'node:assert/strict';
       import { safeReadFile } from ${f.source('secure-io')};
       import { restoreJournalCompaction } from ${f.source('workforce/worker-compaction-snapshot')};
       import { WorkerStateJournal } from ${f.source('workforce/worker-state-journal')};
       const journalPath = ${JSON.stringify(journalPath)};
       const before = String(safeReadFile(journalPath));
       const scope = ${JSON.stringify(scope)};
       for (let i = 0; i < 2; i++) {
         const restored = await restoreJournalCompaction(new WorkerStateJournal({ journalPath }), scope, ${now + 1});
         assert.equal(restored.receipt.generation, 1);
         assert.deepEqual(restored.messages, ${JSON.stringify(messages)});
       }
       await assert.rejects(() => restoreJournalCompaction(new WorkerStateJournal({ journalPath }), scope, ${now + 60_001}), /COMPACTION_EXPIRED/);
       assert.equal(String(safeReadFile(journalPath)), before);`
    );
    expect(String(safeReadFile(journalPath))).toBe(journalBefore);
  }, 45_000);
});
