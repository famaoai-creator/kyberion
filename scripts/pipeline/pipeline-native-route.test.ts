/**
 * `pnpm pipeline --input <native browser pipeline>` refuses the file with the
 * command that runs it, instead of misreading bare ops as other domains
 * (pipeline-run-manifest-model.md §3.5).
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { readValidatedWorkflowAdf } from '../refactor/adf-input.js';

describe('pnpm pipeline and native browser pipelines', () => {
  let dir = '';
  afterEach(() => {
    if (dir) safeRmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const write = (name: string, body: unknown) => {
    dir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `native-route-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    safeMkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    safeWriteFile(file, JSON.stringify(body));
    return pathResolver.toRepoRelative(file);
  };

  it('refuses a native file and names the browser runner', async () => {
    const rel = write('native.json', {
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'goto', params: { url: 'https://app.example.test/' } }],
    });
    await expect(readValidatedWorkflowAdf(rel, { trustResolved: true })).rejects.toThrow(
      `[PIPELINE_NATIVE_BROWSER] ${rel} is a browser actuator native pipeline`
    );
    await expect(readValidatedWorkflowAdf(rel, { trustResolved: true })).rejects.toThrow(
      `next: pnpm kyberion browser run --adf ${rel}`
    );
  });

  it('still loads a pipeline ADF', async () => {
    const rel = write('adf.json', {
      pipeline_id: 'route-adf',
      steps: [{ id: 'open', op: 'browser:goto', params: { url: 'https://app.example.test/' } }],
    });
    const pipeline = await readValidatedWorkflowAdf<{ steps: unknown[] }>(rel, {
      trustResolved: true,
    });
    expect(pipeline.steps).toHaveLength(1);
  });
});
