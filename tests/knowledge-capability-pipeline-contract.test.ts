import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function readJson(relativePath: string): unknown {
  return JSON.parse(safeReadFile(path.join(rootDir, relativePath), { encoding: 'utf8' }) as string);
}

describe('Knowledge capability pipeline contract', () => {
  it('lists capabilities from the governed intent catalog', () => {
    const pipeline = readJson('pipelines/list-capabilities.json') as {
      steps: Array<{ op: string; params?: { path?: string } }>;
    };

    expect(pipeline.steps[0]?.op).toBe('system:read_json');
    expect(pipeline.steps[0]?.params?.path).toBe(
      'knowledge/product/governance/standard-intents.json'
    );
  });

  it('curates markdown knowledge cards through the weekly report pipeline', () => {
    const pipeline = readJson('pipelines/knowledge-curation-weekly.json') as {
      steps: Array<{ op: string }>;
    };

    expect(pipeline.steps.some((step) => step.op === 'wisdom:curation_report')).toBe(true);
    expect(pipeline.steps.some((step) => step.op === 'wisdom:knowledge_validation_sweep')).toBe(
      true
    );
  });
});
