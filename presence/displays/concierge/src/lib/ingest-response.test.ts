import { describe, expect, it } from 'vitest';
import { parseConciergeIngestResponse } from './ingest-response';

describe('concierge ingest response boundary', () => {
  it('preserves canonical inferred project scope and rejects a mismatched owner receipt', () => {
    const selectedWorkspace = { tier: 'public', project_id: 'docs' };
    const receipt = {
      ok: true,
      message: 'Ready',
      summary: {
        dry_run: true,
        outcome: 'would_commit',
        file_name: 'a.txt',
        tenant: '',
        scope: selectedWorkspace,
        selectedWorkspace,
      },
    };
    expect(
      parseConciergeIngestResponse(receipt, {
        tenant: '',
        dryRun: true,
        selection: { project_id: 'docs' },
      })?.summary.selectedWorkspace
    ).toEqual(selectedWorkspace);
    expect(
      parseConciergeIngestResponse(receipt, {
        tenant: '',
        dryRun: true,
        selection: { project_id: 'other' },
      })
    ).toBeUndefined();
    expect(
      parseConciergeIngestResponse({
        ...receipt,
        summary: { ...receipt.summary, scope: { tier: 'personal', project_id: 'docs' } },
      })
    ).toBeUndefined();
  });
  it('accepts dry-run and committed summaries', () => {
    expect(
      parseConciergeIngestResponse({
        ok: true,
        dry_run: true,
        summary: {
          dry_run: true,
          outcome: 'would_commit',
          target_path: 'public/report.md',
          file_name: 'report.md',
          tenant: 'default',
        },
        message: 'Preview ready',
      })
    ).toEqual({
      summary: {
        dry_run: true,
        outcome: 'would_commit',
        target_path: 'public/report.md',
        file_name: 'report.md',
        tenant: 'default',
      },
      message: 'Preview ready',
    });
  });

  it('accepts duplicate summaries without a target path', () => {
    expect(
      parseConciergeIngestResponse({
        ok: true,
        summary: {
          dry_run: false,
          outcome: 'duplicate',
          file_name: 'report.md',
          tenant: 'default',
        },
        message: 'Already registered',
      })
    ).toBeDefined();
  });

  it('rejects malformed outcomes and dangerous keys', () => {
    expect(
      parseConciergeIngestResponse({
        ok: true,
        summary: { dry_run: true, outcome: 'failed', file_name: 'x', tenant: 'default' },
        message: 'x',
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"ok":true,"summary":{"dry_run":true,"outcome":"would_commit","file_name":"x","tenant":"default","constructor":{}},"message":"x"}'
    );
    expect(parseConciergeIngestResponse(unsafe)).toBeUndefined();
  });
});

it.each([
  [true, 'committed'],
  [false, 'would_commit'],
])('rejects incompatible phase %s outcome %s', (dry_run, outcome) => {
  expect(
    parseConciergeIngestResponse({
      ok: true,
      summary: { dry_run, outcome, tenant: 'alpha', file_name: 'report.txt' },
      message: 'x',
    })
  ).toBeUndefined();
});
it('binds a valid response to the requested tenant and phase, not the unsanitized filename', () => {
  const value = {
    ok: true,
    summary: { dry_run: true, outcome: 'would_commit', tenant: 'alpha', file_name: 'report_.txt' },
    message: 'x',
  };
  expect(parseConciergeIngestResponse(value, { tenant: 'alpha', dryRun: true })).toBeDefined();
  expect(parseConciergeIngestResponse(value, { tenant: 'beta', dryRun: true })).toBeUndefined();
  expect(parseConciergeIngestResponse(value, { tenant: 'alpha', dryRun: false })).toBeUndefined();
});
