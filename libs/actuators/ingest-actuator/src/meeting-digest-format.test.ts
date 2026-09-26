import { describe, expect, it } from 'vitest';
import {
  calendarDateAt,
  parseMarkdownDoc,
  parseMeetingDateFromTitle,
  readIndexDates,
  readOpenIssues,
  stripProvisionalNote,
  updateIndexReadme,
  validateMeetingDigestSummary,
  weekdayJa,
} from './meeting-digest-format.js';

describe('meeting-digest-format', () => {
  it('parses meeting dates from the historical title variants', () => {
    expect(parseMeetingDateFromTitle('2026/9/24(木)：Weekly OPS MTG')).toBe('2026-09-24');
    expect(parseMeetingDateFromTitle('2026/6/4(木)：Weekly OPS MT')).toBe('2026-06-04');
    expect(parseMeetingDateFromTitle('2026/2/30(木)：x')).toBeNull();
    expect(parseMeetingDateFromTitle('議事録テンプレート')).toBeNull();
  });

  it('derives weekday and JST calendar dates deterministically', () => {
    expect(weekdayJa('2026-09-24')).toBe('木');
    expect(calendarDateAt(Date.parse('2026-09-24T15:30:00.000Z'))).toBe('2026-09-25');
  });

  it('validates the structured summary and normalizes empties', () => {
    const summary = validateMeetingDigestSummary({
      gist: ['- a', 'b', 'c', 'd'],
      incidents: ['なし'],
      reviews: [],
      decisions: ['なし'],
    });
    expect(summary.gist).toEqual(['a', 'b', 'c']);
    expect(summary.one_line).toBe('a');
    expect(summary.incidents).toEqual([]);
    expect(summary.decisions).toEqual([]);
    expect(() => validateMeetingDigestSummary({ gist: [] })).toThrow(/gist/);
    expect(() => validateMeetingDigestSummary('text')).toThrow(/JSON object/);
  });

  it('drops the provisional note and index marker on finalize', () => {
    expect(
      stripProvisionalNote('# T 2026-09-24(木)\n\n> 暫定版。ページは編集中\n\n## 要旨\n- a')
    ).toBe('# T 2026-09-24(木)\n\n## 要旨\n- a');
    const readme = updateIndexReadme(null, {
      title_prefix: '週次',
      tags: ['t'],
      last_updated: '2026-09-25',
      rows: [{ date: '2026-09-24', one_line: 'x（暫定版）', incidents: 'なし' }],
    });
    const finalized = updateIndexReadme(readme, {
      title_prefix: '週次',
      tags: ['t'],
      last_updated: '2026-09-26',
      rows: [],
      finalize_dates: ['2026-09-24'],
    });
    expect(finalized).toContain('| 2026-09-24 | x | なし |');
  });

  it('creates an index skeleton and upserts rows newest-first', () => {
    const first = updateIndexReadme(null, {
      title_prefix: '週次',
      tags: ['t'],
      last_updated: '2026-09-25',
      rows: [{ date: '2026-09-17', one_line: 'x', incidents: 'なし' }],
      open_issues: [{ topic: '論点A', first_seen: '2026-09-17', latest: '継続' }],
    });
    expect(parseMarkdownDoc(first).frontmatter.title).toBe('週次 索引');
    expect(readOpenIssues(first)).toEqual([
      { topic: '論点A', first_seen: '2026-09-17', latest: '継続' },
    ]);
    const second = updateIndexReadme(first, {
      title_prefix: '週次',
      tags: ['t'],
      last_updated: '2026-09-26',
      rows: [
        { date: '2026-09-24', one_line: 'y|z', incidents: 'あり' },
        { date: '2026-09-17', one_line: 'x2', incidents: 'なし' },
      ],
    });
    expect(readIndexDates(second)).toEqual(['2026-09-24', '2026-09-17']);
    expect(second).toContain('| 2026-09-24 | y｜z | あり | [2026-09-24.md](./2026-09-24.md) |');
    expect(second).toContain('| 2026-09-17 | x2 | なし |');
    expect(readOpenIssues(second).map((i) => i.topic)).toEqual(['論点A']);
    expect(second).toContain('last_updated: 2026-09-26');
  });
});
