import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeSpawn, safeRmSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { applyHearingTurn, createHearingRecord } from './hearing.js';
import { saveHearingRecord, loadHearingRecord } from './hearing-runtime.js';

/** Uses real child processes and the real secure-io lock implementation, not a mocked mutex. */
describe('hearing cross-process transaction', () => {
  it('retains every increment from two simultaneous writers', async () => {
    const namespace = 'zz-hp-' + randomUUID().slice(0, 12);
    const session = 'race';
    saveHearingRecord(namespace, createHearingRecord(session, '0'));
    const runtime = new URL('./hearing-runtime.ts', import.meta.url).href;
    const program =
      'import { updateHearingRecord } from ' +
      JSON.stringify(runtime) +
      ';' +
      'for(let i=0;i<20;i++){updateHearingRecord(' +
      JSON.stringify(namespace) +
      ',' +
      JSON.stringify(session) +
      ',current=>{if(!current)throw new Error("missing record");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4);return {...current,updated_at:String(Number(current.updated_at)+1)}});}';
    const children = [0, 1].map(() =>
      safeSpawn(
        process.execPath,
        [
          '--import',
          fileURLToPath(new URL('../../../scripts/ts-loader.mjs', import.meta.url)),
          '--input-type=module',
          '-e',
          program,
        ],
        {
          cwd: pathResolver.rootDir(),
          env: {
            ...process.env,
            KYBERION_REASONING_BACKEND: 'stub',
            KYBERION_WISDOM_LLM_PROFILE: 'stub',
            KYBERION_DISABLE_EMBEDDINGS: '1',
            KYBERION_PROVIDER_CAPABILITY_PROBE: '0',
          },
        }
      )
    );
    try {
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise<number | null>((resolve, reject) => {
              let stderr = '';
              child.stderr.on('data', (chunk) => {
                stderr += String(chunk);
              });
              child.stdout.resume();
              child.on('error', reject);
              child.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(stderr))));
            })
        )
      );
      expect(results).toEqual([0, 0]);
      expect(loadHearingRecord(namespace, session)).toMatchObject({
        updated_at: '40',
        record_revision: 41,
      });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      safeRmSync(
        pathResolver.rootResolve('active/shared/runtime/hearing/confidential/' + namespace),
        { recursive: true, force: true }
      );
    }
  }, 60_000);
  it('commits one exact receipt across processes and proves it after restart without another write', async () => {
    const namespace = 'zz-hr-' + randomUUID().slice(0, 12);
    const session = 'decision-race';
    let record = createHearingRecord(session, '2026-10-17T00:00:00.000Z');
    for (let i = 0; i < record.requirements.length; i++)
      record = applyHearingTurn(
        record,
        { text: 'answer ' + i, request_id: 'turn-' + i },
        '2026-10-17T00:00:00.000Z'
      );
    saveHearingRecord(namespace, record);
    const current = loadHearingRecord(namespace, session)!;
    const operation = {
      version: 1,
      operation_id: 'race-operation',
      scenario_id: current.scenario,
      requirements_revision: current.requirements_revision,
    };
    const identity = {
      principal_id: 'race-principal',
      scope_key: 'test-scope',
      member_id: 'race-member',
      source: 'loopback',
    };
    const runtime = new URL('./hearing-runtime.ts', import.meta.url).href;
    const setup =
      'import { decideHearingRecord, hearingDecisionReceipt, loadHearingRecord } from ' +
      JSON.stringify(runtime) +
      ';const ns=' +
      JSON.stringify(namespace) +
      ',sid=' +
      JSON.stringify(session) +
      ',op=' +
      JSON.stringify(operation) +
      ',identity=' +
      JSON.stringify(identity) +
      ';';
    const run = (program: string) =>
      new Promise<void>((resolve, reject) => {
        const child = safeSpawn(
          process.execPath,
          [
            '--import',
            fileURLToPath(new URL('../../../scripts/ts-loader.mjs', import.meta.url)),
            '--input-type=module',
            '-e',
            setup + program,
          ],
          {
            cwd: pathResolver.rootDir(),
            env: {
              ...process.env,
              KYBERION_REASONING_BACKEND: 'stub',
              KYBERION_WISDOM_LLM_PROFILE: 'stub',
              KYBERION_DISABLE_EMBEDDINGS: '1',
              KYBERION_PROVIDER_CAPABILITY_PROBE: '0',
            },
          }
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.stdout.resume();
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    try {
      const decide =
        'decideHearingRecord(ns,sid,op,identity,{kind:"human",id:"user:race-member",role:"owner"},"2026-10-17T00:01:00.000Z");';
      await Promise.all([run(decide), run(decide)]);
      const committed = loadHearingRecord(namespace, session)!;
      expect(committed.record_revision).toBe(current.record_revision! + 1);
      expect(committed.decision_receipts).toHaveLength(1);
      await run(
        'const record=loadHearingRecord(ns,sid);const proof=hearingDecisionReceipt(record,ns,op,identity);if(proof?.status!=="current")throw new Error("receipt not recovered");' +
          decide
      );
      expect(loadHearingRecord(namespace, session)).toEqual(committed);
    } finally {
      safeRmSync(
        pathResolver.rootResolve('active/shared/runtime/hearing/confidential/' + namespace),
        { recursive: true, force: true }
      );
    }
  }, 60_000);
});
