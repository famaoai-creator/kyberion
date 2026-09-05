import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { runMarketingVideoDryRun } from './marketing_video_dry_run.js';

const roots: string[] = [];

function fixture(): { briefPath: string; brandPath: string } {
  const root = pathResolver.rootResolve(`active/shared/tmp/marketing-video-path-${Date.now()}`);
  roots.push(root);
  safeMkdir(root, { recursive: true });
  const briefPath = path.join(root, 'brief.json');
  const brandPath = path.join(root, 'brand.json');
  safeWriteFile(briefPath, JSON.stringify({ intake: {} }));
  safeWriteFile(brandPath, '{}');
  return { briefPath, brandPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('marketing video dry-run path boundaries', () => {
  it('uses the foundation reader for approved text artifacts', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/marketing_video_dry_run.ts'));
    expect(source).toContain('parseSafeJsonObjectInput, readTextFile');
  });

  it('rejects a campaign brief outside the repository', () => {
    expect(() =>
      runMarketingVideoDryRun({
        campaignBriefPath: '../package.json',
        brandProfilePath: 'package.json',
        outputRoot: 'active/shared/tmp/marketing-video-output',
        channel: 'youtube',
        riskLevel: 0,
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects an output root outside the repository before running media tools', () => {
    const input = fixture();
    expect(() =>
      runMarketingVideoDryRun({
        campaignBriefPath: input.briefPath,
        brandProfilePath: input.brandPath,
        outputRoot: path.join(pathResolver.rootDir(), '..', 'kyberion-video-output'),
        channel: 'youtube',
        riskLevel: 0,
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects malformed campaign brief JSON before running media tools', () => {
    const input = fixture();
    safeWriteFile(input.briefPath, '{"intake":');

    expect(() =>
      runMarketingVideoDryRun({
        campaignBriefPath: input.briefPath,
        brandProfilePath: input.brandPath,
        outputRoot: 'active/shared/tmp/marketing-video-output',
        channel: 'youtube',
        riskLevel: 0,
      })
    ).toThrow('campaign brief JSON must be valid JSON');
  });
});
