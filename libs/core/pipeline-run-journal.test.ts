import { describe, expect, it } from 'vitest';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  createPipelineRunJournal,
  hashPipelineOutput,
  loadPipelineRunJournal,
  newPipelineRunId,
} from './pipeline-run-journal.js';

describe('pipeline run journal', () => {
  it('records declared channel snapshots and restores completed nodes', () => {
    const runId = `test-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-test',
      input_path: 'pipelines/example.json',
      step_ids: ['source', 'sink'],
    });
    journal.append('node_completed', {
      step_id: 'source',
      output_channels_snapshot: { records: [{ id: 1 }] },
      output_hash: hashPipelineOutput({ records: [{ id: 1 }] }),
    });
    journal.append('run_finished', { status: 'succeeded' });

    const restored = loadPipelineRunJournal(runId);
    expect(restored.started?.pipeline_id).toBe('journal-test');
    expect(restored.completed_nodes.get('source')?.output_channels_snapshot).toEqual({
      records: [{ id: 1 }],
    });
    expect(restored.finished?.status).toBe('succeeded');
    safeRmSync(journal.path);
  });

  it('fails closed on corrupt JSONL', () => {
    const runId = `test-corrupt-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-corrupt-test',
      input_path: 'pipelines/example.json',
      step_ids: ['source'],
    });
    safeWriteFile(journal.path, '{not-json}\n');
    expect(() => loadPipelineRunJournal(runId)).toThrow(/corrupt JSONL journal/);
    safeRmSync(journal.path);
  });

  it('validates lifecycle payloads before appending them', () => {
    const runId = `test-contract-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-contract-test',
      input_path: 'pipelines/example.json',
      step_ids: ['source'],
    });
    const before = String(safeReadFile(journal.path, { encoding: 'utf8' }))
      .trim()
      .split('\n');

    expect(() => journal.append('node_completed', { step_id: 'source' })).toThrow();

    const after = String(safeReadFile(journal.path, { encoding: 'utf8' }))
      .trim()
      .split('\n');
    expect(after).toHaveLength(before.length);
    expect(journal.append('run_finished', { status: 'succeeded' }).sequence).toBe(2);
    safeRmSync(journal.path);
  });
});
