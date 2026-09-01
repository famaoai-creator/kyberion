import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { assertChronosPipelinePath } from './chronos_daemon.js';

describe('chronos pipeline scope', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside pipelines/', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);

    expect(() => assertChronosPipelinePath(path.join(root, '../outside.json'), root)).toThrow(
      '[CHRONOS_SCOPE]'
    );
  });

  it('rejects a symlinked scheduled pipeline', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);
    const pipelines = path.join(root, 'pipelines');
    safeMkdir(pipelines, { recursive: true });
    const target = path.join(root, 'outside.json');
    safeWriteFile(target, '{}');
    fs.symlinkSync(target, path.join(pipelines, 'linked.json'));

    expect(() => assertChronosPipelinePath(path.join(pipelines, 'linked.json'), root)).toThrow(
      'symbolic link'
    );
  });

  it('accepts a regular repository pipeline JSON', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);
    const pipeline = path.join(root, 'pipelines', 'safe.json');
    safeMkdir(path.dirname(pipeline), { recursive: true });
    safeWriteFile(pipeline, '{}');

    expect(() => assertChronosPipelinePath(pipeline, root)).not.toThrow();
  });
});
