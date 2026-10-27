import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  captureVerificationSourceSnapshot,
  verificationFreshness,
} from './verification-source-snapshot.js';
import { executeQualityRun } from './software-quality-operations.js';
import { parseTestExecutionRecord, type TestInventory } from './software-quality.js';

const dir = pathResolver.sharedTmp('verification-source-snapshot-test');
const source = path.join(dir, 'source.ts');
const relative = () => path.relative(pathResolver.rootDir(), source).split(path.sep).join('/');
function seed() {
  safeMkdir(dir, { recursive: true });
  safeWriteFile(source, 'original');
}
afterEach(() => safeRmSync(dir, { recursive: true, force: true }));

describe('content-bound verification freshness', () => {
  it('distinguishes matched targeted evidence, edits, workspaces and absent proof', () => {
    seed();
    const snapshot = captureVerificationSourceSnapshot([relative()]);
    expect(verificationFreshness(snapshot)).toEqual({
      status: 'partial',
      coverage: 'targeted',
      checkedSources: 1,
    });
    expect(verificationFreshness({ ...snapshot, coverage: 'full' }).status).toBe('current');
    safeWriteFile(source, 'edited after verification');
    expect(verificationFreshness(snapshot).status).toBe('stale');
    expect(verificationFreshness({ ...snapshot, workspaceId: '0'.repeat(64) }).status).toBe(
      'unknown'
    );
    expect(verificationFreshness(undefined).status).toBe('unknown');
    safeRmSync(source);
    expect(verificationFreshness(snapshot).status).toBe('unknown');
  });

  it('rejects private, traversal, duplicate, malformed and oversized source proofs', () => {
    seed();
    const snapshot = captureVerificationSourceSnapshot([relative()]);
    for (const sources of [
      [{ path: 'knowledge/personal/secret.json', sha256: '0'.repeat(64) }],
      [{ path: '../outside', sha256: '0'.repeat(64) }],
      [snapshot.sources[0], snapshot.sources[0]],
      [null],
      Array.from({ length: 65 }, () => snapshot.sources[0]),
    ])
      expect(verificationFreshness({ ...snapshot, sources }).status).toBe('unknown');
  });

  it('captures at execution time and withholds a receipt when the test edits its sources', async () => {
    seed();
    const inventory: TestInventory = {
      version: '1',
      project_id: 'p',
      items: [
        {
          item_id: 'T1',
          title: 'test',
          viewpoint_ids: ['unit'],
          risk_level: 'low',
          execution_mode: 'safe_auto',
          expected_result: 'ok',
        },
      ],
    };
    const run = (edit: boolean) =>
      executeQualityRun({
        inventory,
        runId: 'r',
        subjectRef: 'dirty-worktree',
        sourcePaths: [relative()],
        environment: 'fake',
        executor: { resource_id: 'test', resource_type: 'automation' },
        executors: {
          code: async () => {
            if (edit) safeWriteFile(source, 'changed during execution');
            return { status: 'passed', evidence_refs: ['test:fixture'] };
          },
        },
      });
    const stable = await run(false);
    expect(parseTestExecutionRecord(JSON.parse(JSON.stringify(stable)))?.source_snapshot).toEqual(
      stable.source_snapshot
    );
    expect(verificationFreshness(stable.source_snapshot).status).toBe('partial');
    expect((await run(true)).source_snapshot).toBeUndefined();
    expect(verificationFreshness(stable.source_snapshot).status).toBe('stale');
  });
});
