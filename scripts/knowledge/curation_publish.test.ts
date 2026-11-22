import { describe, expect, it } from 'vitest';
import {
  branchName,
  commitMessage,
  parseArgs,
  porcelainPath,
  renderBody,
  reportDate,
} from './curation_publish.js';

describe('parseArgs', () => {
  it('defaults to the governed report path and main base', () => {
    const o = parseArgs([]);
    expect(o.report).toBe('knowledge/product/governance/CURATION_REPORT.md');
    expect(o.base).toBe('main');
    expect(o.dryRun).toBe(false);
    expect(o.force).toBe(false);
  });
  it('parses --report/--date/--base/--dry-run/--force', () => {
    const o = parseArgs([
      '--report',
      'custom/REPORT.md',
      '--date',
      '2026-12-01',
      '--base',
      'develop',
      '--dry-run',
      '--force',
    ]);
    expect(o).toMatchObject({
      report: 'custom/REPORT.md',
      date: '2026-12-01',
      base: 'develop',
      dryRun: true,
      force: true,
    });
  });
});

describe('reportDate', () => {
  it('extracts the generated_at date prefix', () => {
    expect(reportDate('header\ngenerated_at: 2026-11-21T03:00:12+09:00\nrest')).toBe('2026-11-21');
  });
  it('returns undefined when generated_at is absent', () => {
    expect(reportDate('no date here')).toBeUndefined();
  });
});

describe('naming', () => {
  it('derives branch and commit message from the report date', () => {
    expect(branchName('2026-11-21')).toBe('chore/knowledge-curation-20261121');
    expect(commitMessage('2026-11-21')).toBe('chore(knowledge): weekly curation report 2026-11-21');
  });
});

describe('porcelainPath', () => {
  it('strips the two-column status prefix regardless of padding', () => {
    expect(porcelainPath(' M knowledge/x.md')).toBe('knowledge/x.md');
    expect(porcelainPath('M  knowledge/x.md')).toBe('knowledge/x.md');
    expect(porcelainPath('MM knowledge/x.md')).toBe('knowledge/x.md');
  });
  it('takes the destination of a rename', () => {
    expect(porcelainPath('R  old/name.md -> new/name.md')).toBe('new/name.md');
  });
});

describe('renderBody', () => {
  it('satisfies the PR contract: Coordination + explicit none Knowledge', () => {
    const body = renderBody('2026-11-21', 'knowledge/product/governance/CURATION_REPORT.md');
    expect(body).toContain('## Coordination');
    expect(body).toContain('Mission ID: none');
    expect(body).toContain('## Knowledge');
    expect(body).toMatch(/\n- none — /);
    expect(body).toContain('2026-11-21');
    expect(body).toContain('KM-03');
  });
});
