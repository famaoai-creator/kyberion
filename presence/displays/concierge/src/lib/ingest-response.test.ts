import { describe, expect, it } from 'vitest';
import { parseConciergeIngestResponse } from './ingest-response';

describe('concierge ingest response boundary', () => {
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
