import { describe, expect, it } from 'vitest';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  createPipelineRunJournal,
  hashPipelineOutput,
  loadPipelineRunJournal,
  newPipelineRunId,
  readPipelineRunJournal,
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
      control_state_snapshot: { __pipeline_route_next: 'sink' },
      output_hash: hashPipelineOutput({ records: [{ id: 1 }] }),
    });
    journal.append('run_finished', { status: 'succeeded' });

    const restored = loadPipelineRunJournal(runId);
    expect(restored.started?.pipeline_id).toBe('journal-test');
    expect(restored.completed_nodes.get('source')?.output_channels_snapshot).toEqual({
      records: [{ id: 1 }],
    });
    expect(restored.completed_nodes.get('source')?.control_state_snapshot).toEqual({
      __pipeline_route_next: 'sink',
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

  it('fails closed on dangerous JSONL records', () => {
    const runId = `test-dangerous-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-dangerous-test',
      input_path: 'pipelines/example.json',
      step_ids: ['source'],
    });
    safeWriteFile(journal.path, '{"nested":{"constructor":{}}}\n');

    expect(() => loadPipelineRunJournal(runId)).toThrow(/corrupt JSONL journal/);
    safeRmSync(journal.path);
  });

  it('fails closed on a schema-invalid journal envelope', () => {
    const runId = `test-schema-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-schema-test',
      input_path: 'pipelines/example.json',
      step_ids: ['source'],
    });
    const existing = String(safeReadFile(journal.path, { encoding: 'utf8' }));
    safeWriteFile(
      journal.path,
      `${existing}${JSON.stringify({
        version: 3,
        sequence: 2,
        run_id: runId,
        event: 'run_finished',
        timestamp: '2026-08-16T06:00:00.000Z',
        payload: { status: 'succeeded' },
        unexpected: true,
      })}\n`
    );
    expect(() => loadPipelineRunJournal(runId)).toThrow(/Invalid catalog/);
    safeRmSync(journal.path);
  });

  it('rejects a journal path that is a directory', () => {
    const directoryPath = `${pathResolver.sharedTmp(`pipeline-journal-directory-${newPipelineRunId()}`)}.jsonl`;
    safeMkdir(directoryPath, { recursive: true });
    expect(() => readPipelineRunJournal(directoryPath)).toThrow(/regular file/);
    safeRmSync(directoryPath, { recursive: true, force: true });
  });

  it('rejects journal reads outside the repository boundary', () => {
    expect(() => readPipelineRunJournal('/tmp/kyberion-external-pipeline-run.jsonl')).toThrow(
      /RESOURCE_PATH_SCOPE/
    );
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

  it('persists suspension and clears it on a process-boundary resume', () => {
    const runId = `test-suspended-${newPipelineRunId()}`;
    const journal = createPipelineRunJournal(runId, {
      pipeline_id: 'journal-suspended-test',
      input_path: 'pipelines/example.json',
      step_ids: ['judge', 'approval', 'sink'],
    });
    journal.append('run_suspended', {
      step_id: 'approval',
      approval_request_id: 'approval-1',
      storage_channel: 'pipeline-approval',
      on_timeout: 'deny',
      timeout_at: '2026-08-16T06:00:00.000Z',
    });
    expect(loadPipelineRunJournal(runId).suspended).toMatchObject({
      step_id: 'approval',
      approval_request_id: 'approval-1',
    });

    journal.append('run_resumed', { resumed_at: '2026-08-16T05:59:00.000Z' });
    expect(loadPipelineRunJournal(runId).suspended).toBeUndefined();
    safeRmSync(journal.path);
  });
});
