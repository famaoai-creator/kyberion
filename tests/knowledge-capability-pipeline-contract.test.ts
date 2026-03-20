import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

describe('Knowledge capability pipeline contract', () => {
  it('uses capability discovery in the code audit pipeline', () => {
    const pipeline = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/pipelines/code-skill-audit.json'), { encoding: 'utf8' }) as string,
    ) as {
      steps: Array<{ op: string; params?: { export_as?: string } }>;
    };

    expect(pipeline.steps[0]?.op).toBe('discover_capabilities');
    expect(pipeline.steps[0]?.params?.export_as).toBe('all_capabilities');
  });

  it('synchronizes markdown knowledge cards instead of legacy instruction assets', () => {
    const pipeline = JSON.parse(
      safeReadFile(path.join(rootDir, 'knowledge/public/governance/pipelines/wisdom-sync-dates.json'), { encoding: 'utf8' }) as string,
    ) as {
      strategies: Array<{
        for_each?: { params?: { dir?: string; ext?: string; export_as?: string } };
      }>;
    };

    const forEach = pipeline.strategies[0]?.for_each?.params;
    expect(forEach?.dir).toBe('knowledge/public');
    expect(forEach?.ext).toBe('.md');
    expect(forEach?.export_as).toBe('knowledge_cards_to_sync');
  });
});
