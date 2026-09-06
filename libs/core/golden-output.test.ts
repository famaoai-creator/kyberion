import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadGoldenOutputRegistryAtPath, loadGoldenOutputSnapshotAtPath } from './golden-output.js';

const testRoot = pathResolver.sharedTmp(`golden-output-loader-${process.pid}`);
const registryPath = path.join(testRoot, 'pipelines.json');
const snapshotPath = path.join(testRoot, 'snapshot.json');

afterEach(() => {
  safeRmSync(testRoot, { recursive: true, force: true });
});

describe('golden output catalogs', () => {
  it('loads the canonical registry and snapshots', () => {
    expect(loadGoldenOutputRegistryAtPath()).toHaveLength(2);

    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(
      registryPath,
      JSON.stringify([{ id: 'demo', pipeline: 'pipelines/demo.json', input: { mode: 'test' } }])
    );
    safeWriteFile(
      snapshotPath,
      JSON.stringify({
        generated_at: '2026-09-03T00:00:00.000Z',
        pipeline_id: 'demo',
        pipeline_path: 'pipelines/demo.json',
        result_hash: 'a'.repeat(64),
        result: { ok: true },
      })
    );

    expect(loadGoldenOutputRegistryAtPath(registryPath)[0]?.id).toBe('demo');
    expect(loadGoldenOutputSnapshotAtPath(snapshotPath).result).toEqual({ ok: true });
  });

  it('rejects unsafe registry paths and malformed snapshots', () => {
    safeMkdir(testRoot, { recursive: true });
    safeWriteFile(registryPath, JSON.stringify([{ id: 'escape', pipeline: '../outside.json' }]));
    safeWriteFile(
      snapshotPath,
      JSON.stringify({
        generated_at: '2026-09-03T00:00:00.000Z',
        pipeline_id: 'demo',
        pipeline_path: 'pipelines/demo.json',
        result_hash: 'not-a-sha256',
        result: {},
      })
    );

    expect(() => loadGoldenOutputRegistryAtPath(registryPath)).toThrow(
      'Invalid catalog golden-output-registry'
    );
    expect(() => loadGoldenOutputSnapshotAtPath(snapshotPath)).toThrow(
      'Invalid catalog golden-output-snapshot'
    );
  });
});
