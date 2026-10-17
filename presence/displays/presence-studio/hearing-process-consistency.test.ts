import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeSpawn, safeRmSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { createHearingRecord } from './hearing.js';
import { saveHearingRecord, loadHearingRecord } from './hearing-runtime.js';

/** Uses real child processes and the real secure-io lock implementation, not a mocked mutex. */
describe('hearing cross-process transaction', () => {
  it('retains every increment from two simultaneous writers', async () => {
    const namespace = 'zz-hearing-process-' + randomUUID();
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
      safeRmSync(pathResolver.sharedTmp('hearing/' + namespace), { recursive: true, force: true });
    }
  }, 60_000);
});
