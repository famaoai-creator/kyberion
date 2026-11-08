import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { describePipelineFile, listPipelineCatalog } from './pipeline-catalog';

/**
 * Fixture-tree tests for the read-only ADF catalog. Everything lives under a
 * `active/shared/tmp/` scratch root — nothing touches the real `pipelines/`
 * tree — and `describePipelineFile` is asserted against the fixture root so a
 * catalog path is always relative to the root it was scanned from.
 */

const fixtureRoot = pathResolver.sharedTmp(`pipeline-catalog-test-${process.pid}`);

function writeFixture(rel: string, content: string): string {
  const file = path.join(fixtureRoot, rel);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, content);
  return file;
}

const ADF = {
  action: 'pipeline',
  name: 'Daily routine',
  description: 'Runs the daily routine.',
  version: '2.0.0',
  steps: [{ op: 'journal.open' }, { op: 'todo.rollover' }, { op: 'journal.open' }],
  schedule: { enabled: false },
};

afterEach(() => {
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('describePipelineFile', () => {
  it('describes a valid ADF contract (name, ops deduped, step count, schedule)', () => {
    const file = writeFixture('pipelines/daily.json', JSON.stringify(ADF));
    const entry = describePipelineFile(file, fixtureRoot);
    expect(entry).toEqual({
      path: 'pipelines/daily.json',
      name: 'Daily routine',
      description: 'Runs the daily routine.',
      version: '2.0.0',
      ops: ['journal.open', 'todo.rollover'],
      stepCount: 3,
      hasSchedule: true,
    });
  });

  it('falls back to the file basename when the contract has no name', () => {
    const file = writeFixture(
      'pipelines/unnamed.json',
      JSON.stringify({ action: 'pipeline', steps: [{ op: 'x' }] })
    );
    const entry = describePipelineFile(file, fixtureRoot);
    expect(entry.name).toBe('unnamed');
    expect(entry.stepCount).toBe(1);
    expect(entry.hasSchedule).toBe(false);
  });

  it('flags a fragment-shaped file as not a runnable pipeline', () => {
    const file = writeFixture(
      'pipelines/fragments/open-journal.json',
      JSON.stringify({ steps: [{ op: 'journal.open' }] })
    );
    const entry = describePipelineFile(file, fixtureRoot);
    expect(entry.notPipeline).toBe(true);
    expect(entry.parseError).toBeUndefined();
  });

  it('flags broken JSON as a parse error instead of throwing', () => {
    const file = writeFixture('pipelines/broken.json', '{ "action": "pipeline", ');
    const entry = describePipelineFile(file, fixtureRoot);
    expect(entry.parseError).toBe(true);
    expect(entry.notPipeline).toBeUndefined();
    expect(entry.path).toBe('pipelines/broken.json');
  });

  it('flags valid JSON that is not an ADF pipeline', () => {
    for (const [name, content] of [
      ['array.json', '[{"op": "x"}]'],
      ['object.json', '{"kind": "config"}'],
      ['scalar.json', '42'],
    ]) {
      const file = writeFixture(`pipelines/${name}`, content);
      expect(describePipelineFile(file, fixtureRoot).notPipeline).toBe(true);
    }
  });
});

describe('listPipelineCatalog', () => {
  it('collects pipelines/**/*.json sorted by path, skipping fragments', () => {
    writeFixture('pipelines/b-second.json', JSON.stringify(ADF));
    writeFixture('pipelines/a-first.json', JSON.stringify(ADF));
    writeFixture('pipelines/nested/c-third.json', JSON.stringify({ ...ADF, name: 'Nested' }));
    writeFixture('pipelines/fragments/shared.json', JSON.stringify({ steps: [{ op: 'x' }] }));
    writeFixture('pipelines/notes.md', '# not json');

    const entries = listPipelineCatalog(fixtureRoot);
    expect(entries.map((entry) => entry.path)).toEqual([
      'pipelines/a-first.json',
      'pipelines/b-second.json',
      'pipelines/nested/c-third.json',
    ]);
    expect(entries.find((entry) => entry.path === 'pipelines/nested/c-third.json')?.name).toBe(
      'Nested'
    );
  });

  it('returns an empty catalog when the root has no pipelines directory', () => {
    expect(listPipelineCatalog(path.join(fixtureRoot, 'empty-root'))).toEqual([]);
  });
});
