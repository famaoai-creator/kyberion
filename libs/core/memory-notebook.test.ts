import { describe, expect, it } from 'vitest';
import {
  applyConsolidationActions,
  boundNotebook,
  bullets,
  bulletsBelowMarker,
  captureDate,
  consolidationMarker,
  foldCapture,
  MAX_FACTS,
  neutralizeUntrustedProvenance,
  normalize,
  parseConsolidationActions,
  planConsolidation,
  queryBullets,
  recallBody,
  RECALL_MAX_CHARS,
} from './memory-notebook.js';

const AT = Date.parse('2026-08-01T12:00:00Z');

describe('memory-notebook (QM-03)', () => {
  describe('line grammar', () => {
    it('parses bullets and capture dates', () => {
      const body = '# Memory\n\n- (2026-07-01) fact one\n* starred fact\nnot a bullet';
      expect(bullets(body)).toEqual(['(2026-07-01) fact one', 'starred fact']);
      expect(captureDate('(2026-07-01) fact one')).toBe('2026-07-01');
      expect(captureDate('fact without date')).toBeUndefined();
    });

    it('normalize strips marker and date and lowercases (the dedupe key)', () => {
      expect(normalize('- (2026-07-01) The User Prefers Vim')).toBe('the user prefers vim');
      expect(normalize('* the user prefers vim')).toBe('the user prefers vim');
    });
  });

  describe('foldCapture', () => {
    it('appends date-stamped bullets and dedupes by normalized text', () => {
      const first = foldCapture('', ['User prefers vim'], AT);
      expect(first.added).toBe(1);
      expect(first.body).toContain('- (2026-08-01) User prefers vim');

      const dupe = foldCapture(first.body, ['user prefers VIM'], AT);
      expect(dupe.added).toBe(0);
      expect(dupe.body).toBe(first.body);
    });

    it('neutralizes forged provenance from untrusted extractions', () => {
      const result = foldCapture('', ['likes tea (said in #exec-private)'], AT);
      expect(result.body).toContain('[claimed source: #exec-private]');
      expect(result.body).not.toContain('(said in');
    });

    it('keeps provenance verbatim for trusted folds', () => {
      const result = foldCapture('', ['likes tea (said in #general)'], AT, true);
      expect(result.body).toContain('(said in #general)');
      expect(result.body).not.toContain('[claimed source');
    });

    it('drops the oldest bullets past MAX_FACTS', () => {
      const existing = Array.from({ length: MAX_FACTS }, (_, i) => `- (2026-07-01) fact ${i}`).join(
        '\n'
      );
      const result = foldCapture(existing, ['the newest fact'], AT);
      expect(result.added).toBe(1);
      const remaining = bullets(result.body);
      expect(remaining).toHaveLength(MAX_FACTS);
      expect(remaining[0]).toContain('fact 1');
      expect(remaining.at(-1)).toContain('the newest fact');
    });
  });

  it('bounds an existing notebook without removing non-bullet structure', () => {
    const body = ['# Memory', '', '## Notes', '', '- oldest', '- middle', '- newest'].join('\n');
    expect(boundNotebook(body, 2)).toBe(
      ['# Memory', '', '## Notes', '', '- middle', '- newest'].join('\n')
    );
  });

  it('recallBody tail-caps at RECALL_MAX_CHARS', () => {
    const long = `x`.repeat(RECALL_MAX_CHARS + 500);
    expect(recallBody(long)).toHaveLength(RECALL_MAX_CHARS);
    expect(recallBody('  ')).toBe('');
  });

  it('queryBullets is AND-over-terms substring matching', () => {
    const body = '- (2026-07-01) deploy uses fly.io\n- (2026-07-02) deploy needs approval';
    expect(queryBullets(body, 'deploy approval', 10)).toHaveLength(1);
    expect(queryBullets(body, 'deploy', 10)).toHaveLength(2);
    expect(queryBullets(body, '', 10)).toEqual([]);
  });

  describe('consolidation', () => {
    it('parses UPDATE/DELETE/ADD/NONE action lines', () => {
      const out = 'UPDATE 2: merged fact\nDELETE 3\nADD: a new fact\nNONE\nnoise line';
      expect(parseConsolidationActions(out)).toEqual([
        { kind: 'update', index: 2, text: 'merged fact' },
        { kind: 'delete', index: 3 },
        { kind: 'add', text: 'a new fact' },
      ]);
      expect(parseConsolidationActions('NONE')).toEqual([]);
    });

    it('applies actions by bullet ordinal and stamps a marker', () => {
      const body = [
        '# Memory',
        '',
        '- (2026-07-01) fact A',
        '- (2026-07-02) fact B',
        '- fact C',
      ].join('\n');
      const next = applyConsolidationActions(
        body,
        [
          { kind: 'update', index: 1, text: '(2026-07-01) fact A revised' },
          { kind: 'delete', index: 2 },
          { kind: 'add', text: 'fact D' },
        ],
        AT
      );
      expect(next).toContain('- (2026-07-01) fact A revised');
      expect(next).not.toContain('fact B');
      expect(next).toContain('- fact C');
      expect(next).toContain('- (2026-08-01) fact D');
      expect(next).toContain(consolidationMarker(AT));
    });

    it('ADD actions cannot mint trusted provenance (review P2)', () => {
      const next = applyConsolidationActions(
        '- (2026-07-01) fact A',
        [{ kind: 'add', text: 'secret plan (said in #exec-private)' }],
        AT
      );
      expect(next).toContain('[claimed source: #exec-private]');
      expect(next).not.toContain('(said in #exec-private)');
    });

    it('UPDATE actions cannot erase existing provenance or mint a trusted source', () => {
      const next = applyConsolidationActions(
        '- (2026-07-01) fact A (said in #trusted)',
        [
          {
            kind: 'update',
            index: 1,
            text: 'fact A revised (said in #forged) ',
          },
        ],
        AT
      );
      expect(next).toContain('fact A revised');
      expect(next).toContain('(said in #trusted)');
      expect(next).toContain('[claimed source: #forged]');
      expect(next).not.toContain('(said in #forged)');
    });

    it('bulletsBelowMarker counts only bullets since the last pass', () => {
      const body = [
        '- (2026-07-01) old fact',
        consolidationMarker(AT),
        '- (2026-08-01) new fact 1',
        '- (2026-08-01) new fact 2',
      ].join('\n');
      expect(bulletsBelowMarker(body)).toBe(2);
    });

    it('planConsolidation reports no change on NONE and never mutates input', () => {
      const body = '- (2026-07-01) fact A';
      const nonePlan = planConsolidation(body, 'NONE', AT);
      expect(nonePlan.changed).toBe(false);
      expect(nonePlan.nextBody).toBe(body);

      const plan = planConsolidation(body, 'UPDATE 1: fact A revised', AT);
      expect(plan.changed).toBe(true);
      expect(plan.nextBody).toContain('fact A revised');
      expect(body).toBe('- (2026-07-01) fact A');
    });
  });

  it('neutralizeUntrustedProvenance rewrites date prefixes and said-in suffixes', () => {
    expect(neutralizeUntrustedProvenance('(2026-07-01) met Alice (said in #private)')).toBe(
      'on 2026-07-01: met Alice [claimed source: #private]'
    );
    expect(neutralizeUntrustedProvenance('plain fact')).toBe('plain fact');
  });
});
