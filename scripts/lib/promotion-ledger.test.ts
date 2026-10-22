// Hermetic: the tenant ledger lives under a tmp fixture knowledge root
// (IngestLedgerPathOptions.knowledgeRoot), never in real knowledge/.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { deriveAssetId } from '@agent/core/ingest-asset-ledger';
import {
  commitPromotionAsset,
  planPromotionAsset,
  promotionAssetSummary,
  resolvePromotionActor,
  type PromotionAssetInput,
} from './promotion-ledger.js';

const FIXTURE = `active/shared/tmp/vitest-promotion-ledger-${process.pid}`;
const TENANT = 'acme';
const options = { knowledgeRoot: `${FIXTURE}/knowledge/confidential/${TENANT}` };
const TARGET = `${options.knowledgeRoot}/tools/deck/TOOL.json`;

const input = (overrides: Partial<PromotionAssetInput> = {}): PromotionAssetInput => ({
  tenant: TENANT,
  sourceSystem: 'scratch',
  sourceId: 'active/shared/tmp/job-a/work',
  targetPath: TARGET,
  contentSha256: 'a'.repeat(64),
  transformChain: ['scratch_promote:tool'],
  ingestedBy: 'vitest',
  now: '2026-10-21T00:00:00.000Z',
  tag: '[scratch:promote]',
  ...overrides,
});

function land(overrides: Partial<PromotionAssetInput> = {}) {
  const plan = planPromotionAsset(input(overrides), options);
  commitPromotionAsset(TENANT, plan, options);
  return plan;
}

describe('promotion-ledger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(pathResolver.rootResolve(FIXTURE), { recursive: true, force: true });
  });

  it('resolves the actor like ingest:commit and refuses anonymous promotions', () => {
    vi.stubEnv('KYBERION_PERSONA', 'alice');
    vi.stubEnv('MISSION_ROLE', 'worker');
    expect(resolvePromotionActor('[x]')).toBe('alice');
    vi.stubEnv('KYBERION_PERSONA', '');
    expect(resolvePromotionActor('[x]')).toBe('worker');
    vi.stubEnv('MISSION_ROLE', '');
    expect(() => resolvePromotionActor('[x]')).toThrow(/\[x\] tenant promotion refused/);
  });

  it('lands version 1, skips identical content, supersedes changed content', () => {
    const first = land();
    expect(first.action).toBe('append');
    expect(first.record).toMatchObject({ version: 1, visible_to: [TENANT] });
    expect(first.record.supersedes).toBeUndefined();
    expect(land().action).toBe('unchanged');
    const second = land({ contentSha256: 'b'.repeat(64) });
    const assetId = deriveAssetId('scratch', 'active/shared/tmp/job-a/work');
    expect(promotionAssetSummary(second)).toEqual({
      asset_id: assetId,
      version: 2,
      ref: `asset:${assetId}@v2`,
      recorded: true,
      supersedes: `${assetId}@v1`,
    });
  });

  it('links a re-promotion from a new source to the asset that held the target', () => {
    const first = land();
    const replacement = land({
      sourceId: 'active/shared/tmp/job-b/work',
      contentSha256: 'c'.repeat(64),
    });
    expect(replacement.record).toMatchObject({
      version: 1,
      supersedes: `${first.record.asset_id}@v1`,
    });
    // Back to the first source with its old content: the target changed
    // hands, so this is a new version, not a skip.
    const back = land();
    expect(back.action).toBe('append');
    expect(back.record).toMatchObject({
      version: 2,
      supersedes: `${replacement.record.asset_id}@v1`,
    });
  });

  it('refuses a second target for a source already recorded elsewhere', () => {
    land();
    expect(() =>
      planPromotionAsset(
        input({ targetPath: `${options.knowledgeRoot}/tools/other/TOOL.json` }),
        options
      )
    ).toThrow(/\[scratch:promote\] ledger conflict — .* \| .* \| evidence: /);
  });
});
