import { describe, expect, it } from 'vitest';
import { renderStatus } from './ux-vocabulary.js';

describe('ux-vocabulary', () => {
  it('renders readiness statuses through the shared vocabulary catalog', () => {
    expect(renderStatus('readiness', 'needs_clarification', 'ja')).toBe('追加確認が必要');
    expect(renderStatus('readiness', 'fully_automatable', 'en')).toBe('ready to run');
  });

  it('renders mission statuses through the shared vocabulary catalog', () => {
    expect(renderStatus('mission', 'blocked', 'ja')).toBe('停止中');
    expect(renderStatus('mission', 'planned', 'en')).toBe('planned');
  });

  it('renders progress statuses through the shared vocabulary catalog', () => {
    expect(renderStatus('progress', 'working', 'ja')).toBe('処理中');
    expect(renderStatus('progress', 'failed', 'en')).toBe('Failed');
  });

  it('covers operator dashboard connection, provider, mission, and runtime states', () => {
    expect(renderStatus('connection', 'blocked', 'ja')).toBe('要対応');
    expect(renderStatus('provider', 'missing', 'en')).toBe('missing');
    expect(renderStatus('mission', 'distilling', 'ja')).toBe('学習整理中');
    expect(renderStatus('runtime', 'stale', 'en')).toBe('stale');
  });
});
