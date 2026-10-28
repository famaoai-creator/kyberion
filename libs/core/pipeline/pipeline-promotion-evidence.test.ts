import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeRmSync } from '../secure-io.js';
import { createPipelineRunJournal, newPipelineRunId } from './pipeline-run-journal.js';
import { verifyPipelinePromotionEvidence } from './pipeline-promotion-evidence.js';

const sourceSha256 = createHash('sha256').update('source').digest('hex');
const paths: string[] = [];

function run(
  options: {
    digest?: string;
    tenant?: string;
    tier?: string;
    failed?: boolean;
    terminal?: boolean;
    completed?: boolean;
  } = {}
) {
  if (options.tenant) vi.stubEnv('KYBERION_TENANT', options.tenant);
  vi.stubEnv('KYBERION_TIER', options.tier ?? 'public');
  const journal = createPipelineRunJournal(
    newPipelineRunId(),
    {
      pipeline_id: 'promotion',
      input_path: 'pipelines/source.json',
      pipeline_sha256: options.digest ?? sourceSha256,
      trace_id: 'trace-bound-to-run',
      step_ids: ['perform'],
    },
    undefined,
    options.tenant
      ? {
          tier: options.tier === 'personal' ? 'personal' : 'confidential',
          tenantSlug: options.tenant,
        }
      : { tier: 'public' }
  );
  paths.push(journal.path);
  if (options.completed !== false)
    journal.append('node_completed', {
      step_id: 'perform',
      output_channels_snapshot: {},
      output_hash: sourceSha256,
    });
  if (options.failed) journal.append('node_failed', { step_id: 'perform', error: 'failure' });
  if (options.terminal !== false) journal.append('run_finished', { status: 'succeeded' });
  vi.unstubAllEnvs();
  return journal;
}

const verify = (runId: string, extra = {}) =>
  verifyPipelinePromotionEvidence({
    runId,
    inputPath: 'pipelines/source.json',
    sourceSha256,
    ...extra,
  });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const file of paths.splice(0)) safeRmSync(file, { force: true });
});

describe('pipeline promotion proof', () => {
  it('resolves the persisted engine journal and binds its trace and source', () => {
    const journal = run();
    expect(verify(journal.runId, { traceId: 'trace-bound-to-run' })).toMatchObject({
      run_id: journal.runId,
      trace_id: 'trace-bound-to-run',
      source_sha256: sourceSha256,
      tier: 'public',
      completed_at: expect.any(String),
    });
  });
  it('refuses unknown IDs and traversal before reading another partition', () => {
    expect(() => verify('../other')).toThrow('bounded engine run ID');
    expect(() => verify(newPipelineRunId())).toThrow();
  });
  it('refuses an altered source, path, and unrelated trace', () => {
    const journal = run();
    expect(() => verify(journal.runId, { sourceSha256: 'a'.repeat(64) })).toThrow(
      'differs from the executed ADF'
    );
    expect(() => verify(journal.runId, { inputPath: 'pipelines/other.json' })).toThrow(
      'different source'
    );
    expect(() => verify(journal.runId, { traceId: 'unrelated' })).toThrow('trace is not bound');
  });
  it.each([{ terminal: false }, { failed: true }, { completed: false }])(
    'never treats a partial or recovered run as successful source proof: %j',
    (options) => {
      expect(() => verify(run(options).runId)).toThrow('PIPELINE_PROMOTION_UNVERIFIED');
    }
  );
  it('does not accept confidential execution evidence for a public promotion', () => {
    const journal = run({ tier: 'confidential', tenant: 'acme' });
    expect(() => verify(journal.runId)).toThrow();
    expect(() => verify(journal.runId, { tenantSlug: 'other' })).toThrow();
    expect(verify(journal.runId, { tenantSlug: 'acme' })).toMatchObject({
      tier: 'confidential',
      tenant_slug: 'acme',
    });
  });
});
