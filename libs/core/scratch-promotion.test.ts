import { describe, expect, it } from 'vitest';
import {
  classifyPromotionSourceScope,
  isAdfJsonText,
  isUnknownTierSource,
  isAuthoredScratchFile,
  scratchJobDirFor,
  scratchPromoteCommand,
  suggestScratchToolName,
} from './scratch-promotion.js';

describe('scratch promotion classifiers', () => {
  it('recognizes authored code by extension and ADF json by a top-level steps array', () => {
    const never = () => {
      throw new Error('must not read non-json files');
    };
    expect(isAuthoredScratchFile('a/build.ts', never)).toBe(true);
    expect(isAuthoredScratchFile('a/run.sh', never)).toBe(true);
    expect(isAuthoredScratchFile('a/out.pptx', never)).toBe(false);
    expect(isAuthoredScratchFile('a/node_modules/x/index.js', never)).toBe(false);
    expect(isAuthoredScratchFile('a/flow.json', () => '{"steps":[]}')).toBe(true);
    expect(isAuthoredScratchFile('a/data.json', () => '{"rows":[]}')).toBe(false);
    expect(isAuthoredScratchFile('a/big.json', () => null)).toBe(false);
    expect(isAuthoredScratchFile('a/TOOL.json', () => '{"steps":[]}')).toBe(false);
    expect(isAdfJsonText('[1]')).toBe(false);
    expect(isAdfJsonText('not json')).toBe(false);
  });

  it('resolves the job directory for legacy, system and tier partitions', () => {
    expect(scratchJobDirFor('active/shared/tmp/job/work/build.ts')).toBe('active/shared/tmp/job');
    expect(scratchJobDirFor('active/shared/tmp/loose.json')).toBeNull();
    expect(scratchJobDirFor('active/shared/tmp/system/media/j1/a.ts')).toBe(
      'active/shared/tmp/system/media/j1'
    );
    expect(scratchJobDirFor('active/shared/tmp/system/media/a.ts')).toBeNull();
    expect(scratchJobDirFor('active/shared/tmp/confidential/acme/media/j1/x/a.ts')).toBe(
      'active/shared/tmp/confidential/acme/media/j1'
    );
    expect(scratchJobDirFor('active/shared/staging/x/a.ts')).toBeNull();
  });

  it('classifies tier/tenant-bearing source paths and leaves public/legacy paths unscoped', () => {
    expect(classifyPromotionSourceScope('active/shared/tmp/job/a.json')).toBeNull();
    expect(classifyPromotionSourceScope('active/shared/tmp/system/d/j/a.json')).toBeNull();
    expect(classifyPromotionSourceScope('active/shared/tmp/public/shared/d/j/a.json')).toBeNull();
    expect(classifyPromotionSourceScope('pipelines/x.json')).toBeNull();
    expect(classifyPromotionSourceScope('active/shared/tmp/confidential/acme/d/a.json')).toEqual({
      tier: 'confidential',
      tenant: 'acme',
      location: 'active/shared/tmp/confidential/acme',
    });
    expect(
      classifyPromotionSourceScope('active/shared/staging/public/acme/d/a.json')
    ).toMatchObject({ tier: 'public', tenant: 'acme' });
    expect(classifyPromotionSourceScope('knowledge/personal/notes/a.json')).toMatchObject({
      tier: 'personal',
    });
    expect(classifyPromotionSourceScope('knowledge/confidential/acme/x.json')).toMatchObject({
      tier: 'confidential',
      tenant: 'acme',
    });
    expect(
      classifyPromotionSourceScope('active/missions/confidential/acme/MSN-1/evidence/a.json')
    ).toMatchObject({ tier: 'confidential', tenant: 'acme' });
    expect(classifyPromotionSourceScope('customer/acme/x.json')).toMatchObject({
      tenant: 'acme',
    });
  });

  it('builds the exact promote command', () => {
    expect(suggestScratchToolName('active/shared/tmp/Deck Builder_v2')).toBe('deck-builder-v2');
    expect(scratchPromoteCommand({ dir: 'active/shared/tmp/confidential/acme/d/j1' })).toBe(
      'pnpm scratch:promote --from active/shared/tmp/confidential/acme/d/j1 --name j1 --tenant acme'
    );
    expect(scratchPromoteCommand({ dir: 'active/shared/tmp/job', name: 'deck' })).toBe(
      'pnpm scratch:promote --from active/shared/tmp/job --name deck --tenant <slug>'
    );
  });

  it('flags unpartitioned scratch and mission dirs as tier-unknown', () => {
    expect(isUnknownTierSource('active/shared/tmp/job/a.ts')).toBe(true);
    expect(isUnknownTierSource('active/shared/staging/job/a.ts')).toBe(true);
    expect(isUnknownTierSource('active/missions/MSN-X/evidence/a.json')).toBe(true);
    expect(isUnknownTierSource('active/shared/tmp/system/d/j/a.ts')).toBe(false);
    expect(isUnknownTierSource('active/shared/tmp/public/shared/d/j/a.ts')).toBe(false);
    expect(isUnknownTierSource('active/missions/public/MSN-X/a.json')).toBe(false);
    expect(isUnknownTierSource('pipelines/x.json')).toBe(false);
  });

  it('classifies case-variant tier and tenant segments (case-insensitive filesystems)', () => {
    expect(
      classifyPromotionSourceScope('active/shared/tmp/Confidential/Acme/d/a.json')
    ).toMatchObject({ tier: 'confidential', tenant: 'acme' });
    expect(classifyPromotionSourceScope('knowledge/CONFIDENTIAL/acme/x.json')).toMatchObject({
      tier: 'confidential',
    });
    expect(
      classifyPromotionSourceScope('Active/Shared/Tmp/Personal/shared/d/a.json')
    ).toMatchObject({ tier: 'personal' });
    expect(scratchJobDirFor('active/shared/tmp/Confidential/acme/d/j1/a.ts')).toBe(
      'active/shared/tmp/Confidential/acme/d/j1'
    );
  });
});
