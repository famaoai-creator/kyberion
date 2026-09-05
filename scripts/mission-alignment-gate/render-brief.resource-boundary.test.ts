import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveRenderBriefInputPath, resolveRenderBriefOutputPath } from './render-brief.js';

const root = pathResolver.sharedTmp(`render-brief-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('render-brief resource boundary', () => {
  it('rejects repository-external input and output paths', () => {
    expect(() => resolveRenderBriefInputPath('/tmp/mission-brief.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => resolveRenderBriefOutputPath('/tmp/mission-brief.html')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects symlinked brief inputs and output targets', () => {
    const target = path.join(root, 'target');
    const briefLink = path.join(root, 'brief.json');
    const outputLink = path.join(root, 'brief.html');
    safeMkdir(target, { recursive: true });
    safeWriteFile(path.join(target, 'brief.json'), '{}\n');
    safeWriteFile(path.join(target, 'brief.html'), 'old\n');
    safeSymlinkSync(path.join(target, 'brief.json'), briefLink);
    safeSymlinkSync(path.join(target, 'brief.html'), outputLink);

    expect(() => resolveRenderBriefInputPath(briefLink)).toThrow('[RESOURCE_PATH_SYMLINK]');
    expect(() => resolveRenderBriefOutputPath(outputLink)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
