/**
 * MP-02: beat duration follows reading time, not a fixed weight table.
 *
 * Under the old weight-only split a one-line CTA and a dense feature beat got
 * the same share of the runtime, so some beats flashed past unread while
 * others held on almost nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  compileVideoContentBriefToStoryboard,
  estimateReadingTimeSec,
} from './video-content-brief-contract.js';

function brief(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'video-content-brief',
    version: '1.0.0',
    audience: '運用担当者',
    objective: '導入効果を伝える',
    distribution_channel: 'youtube',
    content_type: 'product-walkthrough',
    presentation_mode: 'howto',
    promise: '短く。',
    desired_takeaway: '次へ。',
    constraints: [],
    proof_points: ['実績A'],
    duration_sec: 20,
    design_system_ref: { system_id: 'kyberion-standard', brand_name: 'Kyberion' },
    ...overrides,
  } as any;
}

describe('estimateReadingTimeSec', () => {
  it('returns zero for empty text', () => {
    expect(estimateReadingTimeSec('')).toBe(0);
    expect(estimateReadingTimeSec('   ')).toBe(0);
  });

  it('grows with length', () => {
    const short = estimateReadingTimeSec('短い文です。');
    const long = estimateReadingTimeSec('短い文です。'.repeat(8));
    expect(long).toBeGreaterThan(short);
  });

  it('reads Japanese slower per character than latin', () => {
    // 20 CJK characters against 20 latin characters — the CJK run carries far
    // more information and must be given more time.
    const japanese = estimateReadingTimeSec('あ'.repeat(20));
    const latin = estimateReadingTimeSec('a'.repeat(20));
    expect(japanese).toBeGreaterThan(latin);
  });
});

describe('storyboard beat timing', () => {
  it('gives a text-heavy beat more time than a terse one', () => {
    const storyboard = compileVideoContentBriefToStoryboard(
      brief({
        promise: '短く。',
        objective:
          '本施策では既存の業務プロセスを段階的に自動化し、担当者の確認負荷を下げながら品質を維持します。加えて監査証跡を自動で残すため、運用開始後の検証コストも継続的に低減できます。',
        desired_takeaway: '次へ。',
      })
    );
    const hook = storyboard.beats.find((beat) => beat.beat_id === 'hook');
    const context = storyboard.beats.find((beat) => beat.beat_id === 'context');
    expect(hook).toBeDefined();
    expect(context).toBeDefined();
    expect(context!.duration_sec).toBeGreaterThan(hook!.duration_sec);
  });

  it('still honors the requested total runtime exactly', () => {
    const storyboard = compileVideoContentBriefToStoryboard(brief({ duration_sec: 24 }));
    const total = storyboard.beats.reduce((sum, beat) => sum + beat.duration_sec, 0);
    expect(Math.round(total * 100) / 100).toBe(24);
  });

  it('keeps beats contiguous with no gaps or overlaps', () => {
    const storyboard = compileVideoContentBriefToStoryboard(brief({ duration_sec: 18 }));
    let cursor = 0;
    for (const beat of storyboard.beats) {
      expect(Math.abs(beat.start_sec - cursor)).toBeLessThan(0.011);
      cursor = Math.round((cursor + beat.duration_sec) * 100) / 100;
    }
  });

  it('is deterministic for the same brief', () => {
    const input = brief({ duration_sec: 20 });
    const first = compileVideoContentBriefToStoryboard(input);
    const second = compileVideoContentBriefToStoryboard(input);
    expect(first.beats.map((beat) => beat.duration_sec)).toEqual(
      second.beats.map((beat) => beat.duration_sec)
    );
  });
});
