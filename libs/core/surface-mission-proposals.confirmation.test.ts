import { describe, expect, it } from 'vitest';
import {
  isSlackMissionConfirmation,
  isSlackMissionRejection,
} from './surface-mission-proposals.js';

// UX-04 acceptance 2: numbered-choice confirmation (1=create / 2=decline)
// with generous yes/はい acceptance and an explicit decline path.
describe('mission proposal confirmation grammar (UX-04)', () => {
  it('accepts the numbered choice and the classic affirmations', () => {
    for (const text of ['1', '1)', '1.', '作成する', '実行する', 'はい', 'yes', 'お願いします']) {
      expect(isSlackMissionConfirmation(text), `should accept: ${text}`).toBe(true);
    }
  });

  it('recognizes explicit declines', () => {
    for (const text of [
      '2',
      '2)',
      'やめる',
      'やめて',
      'キャンセル',
      '中止',
      'no',
      'cancel',
      'stop',
    ]) {
      expect(isSlackMissionRejection(text), `should decline: ${text}`).toBe(true);
    }
  });

  it('keeps ordinary utterances out of both buckets', () => {
    for (const text of ['来週の予定を教えて', 'what is 1+1', 'ステータスは?']) {
      expect(isSlackMissionConfirmation(text)).toBe(false);
      expect(isSlackMissionRejection(text)).toBe(false);
    }
  });

  it('never classifies the same text as both confirm and decline', () => {
    for (const text of ['1', '2', 'はい', 'やめる', 'yes', 'no']) {
      expect(isSlackMissionConfirmation(text) && isSlackMissionRejection(text)).toBe(false);
    }
  });
});
