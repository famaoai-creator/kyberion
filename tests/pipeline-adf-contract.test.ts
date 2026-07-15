import { describe, expect, it } from 'vitest';
import {
  derivePipelineStatus,
  safeReadFile,
  safeReaddir,
  validatePipelineAdf,
  validatePipelineGuardrails,
} from '@agent/core';

describe('Pipeline ADF contract', () => {
  it('accepts the canonical JSON pipeline shape used by runtime pipelines', () => {
    const content = safeReadFile('pipelines/vital-check.json', { encoding: 'utf8' }) as string;
    const pipeline = validatePipelineAdf(JSON.parse(content));

    expect(pipeline.action).toBe('pipeline');
    expect(pipeline.steps.length).toBeGreaterThan(0);
    expect(pipeline.steps[0]?.op).toBe('system:log');
  });

  it('rejects malformed pipeline definitions', () => {
    expect(() => validatePipelineAdf({ steps: [{ params: {} }] })).toThrow(/Invalid pipeline ADF/);
  });

  it('derives a failed pipeline status from step failures', () => {
    expect(derivePipelineStatus([{ op: 'x', status: 'success' }])).toBe('succeeded');
    expect(
      derivePipelineStatus([
        { op: 'x', status: 'success' },
        { op: 'y', status: 'failed', error: 'boom' },
      ])
    ).toBe('failed');
  });
});

// LE-05: the whole catalog must stay statically valid — AR-08 found that 75/77
// pipelines had never been validated and ~half of them failed at runtime.
// Every *.json under pipelines/ and pipelines/fragments/ must either be a
// valid pipeline ADF (schema + zero guardrail errors) or be listed here as data.
const KNOWN_DATA_FILES = new Set([
  // PPTX design protocol consumed via media:json_read, not a pipeline
  'pipelines/fragments/masterclass_design_protocol.json',
  // PPTX design protocol demo added on main (2026-07-15), same class of data file
  'pipelines/fragments/design_system_demo_protocol.json',
]);

function listPipelineJsonFiles(): string[] {
  const files: string[] = [];
  for (const dir of ['pipelines', 'pipelines/fragments', 'knowledge/product/pipeline-templates']) {
    for (const name of safeReaddir(dir)) {
      if (name.endsWith('.json')) files.push(`${dir}/${name}`);
    }
  }
  return files.sort();
}

describe('Pipeline catalog static validation (LE-05)', () => {
  const files = listPipelineJsonFiles();

  it('finds a non-trivial catalog', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files)('%s passes schema + guardrail validation', (relative) => {
    const raw = JSON.parse(safeReadFile(relative, { encoding: 'utf8' }) as string) as Record<
      string,
      unknown
    >;

    if (!Array.isArray(raw.steps)) {
      // Data files are only tolerated when explicitly registered above —
      // otherwise a misplaced or truncated pipeline would silently pass.
      expect(
        KNOWN_DATA_FILES.has(relative),
        `${relative} has no steps array and is not a registered data file`
      ).toBe(true);
      return;
    }

    const pipeline = validatePipelineAdf(raw);
    const report = validatePipelineGuardrails(pipeline, relative);
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
  });
});
