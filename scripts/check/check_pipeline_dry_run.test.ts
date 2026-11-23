import { describe, expect, it } from 'vitest';
import { assessPipelineDryRun } from '@agent/core/pipeline/pipeline-dry-run';
import { normalizePipelineOp } from '@agent/core/pipeline/pipeline-op-aliases';
import { runInlineSystemAssert } from '../pipeline/pipeline-execution-part-bootstrap.js';
import {
  assessCatalogEntry,
  formatSweepReport,
  sweepPipelineCatalog,
} from './check_pipeline_dry_run.js';

describe('pipeline catalog dry-run gate', () => {
  it('finds no blocked or invalid catalog pipeline', () => {
    const entries = sweepPipelineCatalog();
    const failures = entries.filter(
      (entry) => entry.verdict === 'blocked' || entry.verdict === 'invalid'
    );
    expect(failures.map((entry) => `${entry.file}: ${entry.messages.join(' | ')}`)).toEqual([]);
  });

  it('requires every reference-marked file to carry an execution note', () => {
    const references = sweepPipelineCatalog().filter((entry) => entry.verdict === 'reference');
    expect(references.length).toBeGreaterThan(0);
    for (const entry of references) {
      expect(entry.messages[0]?.trim().length, entry.file).toBeGreaterThan(0);
    }
  });

  it('treats a reference marker without a note as invalid, not exempt', () => {
    const entry = assessCatalogEntry('x.json', {
      _execution_status: 'reference',
      _execution_note: '   ',
      action: 'pipeline',
      steps: [],
    });
    expect(entry.verdict).toBe('invalid');
    expect(entry.messages[0]).toContain('_execution_note');
  });

  it('keeps include-driven channels resolvable for downstream consumers', () => {
    const entry = sweepPipelineCatalog().find(
      (item) => item.file === 'pipelines/ui-voice-browser-smoke.json'
    );
    expect(entry?.verdict, entry?.messages.join(' | ')).not.toBe('blocked');
  });

  it('renders a one-line summary plus per-file findings', () => {
    const report = formatSweepReport([
      { file: 'a.json', verdict: 'ready', messages: [] },
      { file: 'b.json', verdict: 'blocked', messages: ['flow-contract: x'] },
    ]);
    expect(report).toContain('ready 1');
    expect(report).toContain('blocked 1');
    expect(report).toContain('- blocked: b.json');
  });
});

describe('normalizePipelineOp', () => {
  it('maps bare control ops to core:* and leaves them dispatch-identical', () => {
    expect(normalizePipelineOp('if')).toBe('core:if');
    expect(normalizePipelineOp('loop_until')).toBe('core:while');
    expect(normalizePipelineOp('judge_route')).toBe('core:judge_route');
  });

  it('defaults unknown bare ops to the system domain', () => {
    expect(normalizePipelineOp('log')).toBe('system:log');
    expect(normalizePipelineOp('assert')).toBe('system:assert');
  });

  it('preserves qualified ops and resolves qualified aliases', () => {
    expect(normalizePipelineOp('browser:goto')).toBe('browser:goto');
    expect(normalizePipelineOp('mission:list')).toBe('system:list_missions');
    expect(normalizePipelineOp('agent:list-manifests')).toBe('agent:list_manifests');
  });

  it('keeps dry-run capability resolution aligned with runtime dispatch', () => {
    const pipeline = {
      action: 'pipeline',
      name: 'alias-check',
      version: '1.0.0',
      steps: [{ id: 's1', role: 'sink', op: 'system:assert', params: { conditions: [] } }],
    };
    const report = assessPipelineDryRun(pipeline as never, { providerSnapshot: null });
    expect(
      report.checks.filter(
        (check) => check.status === 'blocked' && check.id === 'capability-resolution'
      )
    ).toEqual([]);
  });
});

describe('system:assert', () => {
  it('passes when every structured condition holds', async () => {
    const ctx = { tenant: 'acme', count: 2 };
    await expect(
      runInlineSystemAssert(
        {
          conditions: [
            { from: 'tenant', operator: 'not_empty' },
            { from: 'count', operator: 'gt', value: 1 },
          ],
        },
        ctx
      )
    ).resolves.toBe(ctx);
  });

  it('fails fast with the failing conditions listed', async () => {
    await expect(
      runInlineSystemAssert(
        {
          message: 'tenant required',
          conditions: [{ from: 'tenant', operator: 'not_empty' }],
        },
        {}
      )
    ).rejects.toThrow(/\[ASSERT_FAILED\] tenant required/);
  });

  it('rejects an empty conditions array', async () => {
    await expect(runInlineSystemAssert({ conditions: [] }, {})).rejects.toThrow(
      /non-empty params\.conditions/
    );
  });
});
