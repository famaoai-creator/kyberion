import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import { createPipelineRunJournal, newPipelineRunId } from './pipeline-run-journal.js';
import { inspectPipelineReuse } from './pipeline-reuse.js';
import * as approvalReader from '../governance/approval-store-reader.js';

const paths: string[] = [];
const sha = 'b'.repeat(64);
const scope = { tier: 'public' as const };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const file of paths.splice(0)) safeRmSync(file, { force: true });
});

describe('pipeline revision reuse', () => {
  it('keeps valid outcomes visible and explicitly marks unreadable evidence incomplete', () => {
    vi.stubEnv('KYBERION_TIER', 'public');
    const started = {
      pipeline_id: 'broken',
      input_path: 'pipelines/baseline-check.json',
      pipeline_sha256: sha,
      step_ids: ['one'],
    };
    const journal = createPipelineRunJournal(newPipelineRunId(), started, undefined, scope);
    paths.push(journal.path);
    journal.append('run_started', { ...started });
    expect(
      inspectPipelineReuse({
        documentPath: 'pipelines/baseline-check.json',
        sourceSha256: sha,
        scope,
      })
    ).toMatchObject({
      evidence_complete: false,
      unreadable_runs: expect.any(Number),
      verified_successes: 0,
    });
  });
  it.each([
    ['service', false, 0],
    ['human', true, 1],
  ] as const)(
    'counts only an authenticated human decision, never an automatic resume (%s)',
    (decidedByType, authenticated, interventions) => {
      vi.stubEnv('KYBERION_TIER', 'public');
      vi.spyOn(approvalReader, 'loadApprovalRequest').mockReturnValue({
        scope,
        status: 'approved',
        decidedByType,
        authenticated,
      } as never);
      const revision = decidedByType === 'human' ? 'd'.repeat(64) : 'e'.repeat(64);
      const journal = createPipelineRunJournal(
        newPipelineRunId(),
        {
          pipeline_id: 'baseline-check',
          input_path: 'pipelines/baseline-check.json',
          pipeline_sha256: revision,
          step_ids: ['one'],
        },
        undefined,
        scope
      );
      paths.push(journal.path);
      journal.append('run_suspended', {
        step_id: 'one',
        approval_request_id: 'approval-one',
        storage_channel: 'terminal',
        on_timeout: 'abort',
      });
      journal.append('run_resumed', { resumed_at: new Date().toISOString() });
      journal.append('node_completed', {
        step_id: 'one',
        output_channels_snapshot: {},
        output_hash: revision,
      });
      journal.append('run_finished', { status: 'succeeded' });
      expect(
        inspectPipelineReuse({
          documentPath: 'pipelines/baseline-check.json',
          sourceSha256: revision,
          scope,
        })
      ).toMatchObject({
        attempts: 1,
        interventions,
        intervention_unknown: 0,
      });
    }
  );
  it('projects engine successes, incomplete runs, and changed revisions without another store', () => {
    vi.stubEnv('KYBERION_TIER', 'public');
    const run = (digest: string, terminal: boolean) => {
      const journal = createPipelineRunJournal(
        newPipelineRunId(),
        {
          pipeline_id: 'baseline-check',
          input_path: 'pipelines/baseline-check.json',
          pipeline_sha256: digest,
          step_ids: ['one'],
        },
        undefined,
        scope
      );
      paths.push(journal.path);
      journal.append('node_completed', {
        step_id: 'one',
        output_channels_snapshot: {},
        output_hash: sha,
      });
      if (terminal) journal.append('run_finished', { status: 'succeeded' });
    };
    run(sha, true);
    run(sha, false);
    run('c'.repeat(64), true);
    expect(
      inspectPipelineReuse({
        documentPath: 'pipelines/baseline-check.json',
        sourceSha256: sha,
        scope,
      })
    ).toMatchObject({
      attempts: 2,
      verified_successes: 1,
      unconfirmed: 1,
      intervention_unknown: 2,
    });
  });
});
