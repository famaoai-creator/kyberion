import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendSemanticDegradationRun,
  summarizeSemanticDegradations,
} from './semantic-degradation-log.js';

describe('semantic-degradation-log', () => {
  const filePath = pathResolver.rootResolve(
    'active/shared/runtime/feedback-loop/semantic-degradations.json'
  );
  let original: string | null = null;

  beforeEach(() => {
    original = safeExistsSync(filePath)
      ? (safeReadFile(filePath, { encoding: 'utf8' }) as string)
      : null;
    if (safeExistsSync(filePath)) safeRmSync(filePath);
  });

  afterEach(() => {
    if (original !== null) safeWriteFile(filePath, original);
    else if (safeExistsSync(filePath)) safeRmSync(filePath);
  });

  it('persists schema-valid degradation runs and summarizes them', () => {
    appendSemanticDegradationRun('pipeline-a', { backend_error: 2, timeout: 1 });

    expect(summarizeSemanticDegradations({ sinceMs: 60_000 })).toMatchObject({
      runs: 1,
      total: 3,
      by_reason: { backend_error: 2, timeout: 1 },
    });
  });

  it('treats a schema-invalid persisted log as empty observability state', () => {
    safeWriteFile(filePath, JSON.stringify([{ at: 'not-a-date', pipeline_id: 'pipeline-a' }]));

    expect(summarizeSemanticDegradations({ sinceMs: 60_000 })).toEqual({
      runs: 0,
      total: 0,
      by_reason: {},
      top_pipelines: [],
    });
  });
});
