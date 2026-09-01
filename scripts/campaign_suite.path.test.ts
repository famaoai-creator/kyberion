import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { runCampaignSuite } from './campaign_suite.js';

const roots: string[] = [];

function briefPath(): string {
  const root = pathResolver.rootResolve(`active/shared/tmp/campaign-path-test-${Date.now()}`);
  roots.push(root);
  safeMkdir(root, { recursive: true });
  const filePath = path.join(root, 'brief.json');
  safeWriteFile(
    filePath,
    JSON.stringify({
      kind: 'campaign-brief',
      title: 'Path boundary test',
      audience: 'operators',
      deliverables: [],
      key_messages: ['Keep paths governed'],
    })
  );
  return filePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('campaign suite path boundaries', () => {
  it('rejects a brief outside the repository', () => {
    expect(() =>
      runCampaignSuite({
        briefPath: '../package.json',
        outputRoot: 'active/shared/tmp/campaign-path-test-output',
        dryRun: true,
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects an output root outside the repository', () => {
    expect(() =>
      runCampaignSuite({
        briefPath: briefPath(),
        outputRoot: path.join(pathResolver.rootDir(), '..', 'kyberion-campaign-output'),
        dryRun: true,
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
