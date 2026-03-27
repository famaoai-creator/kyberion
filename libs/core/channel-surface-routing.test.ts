import { describe, expect, it } from 'vitest';
import { deriveSurfaceDelegationReceiver } from './channel-surface.js';

describe('channel-surface routing helpers', () => {
  it('routes mission and system queries to chronos-mirror', () => {
    expect(deriveSurfaceDelegationReceiver('ミッション一覧を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiver('システム状態を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiver('runtime status please')).toBe('chronos-mirror');
  });

  it('routes deeper reasoning requests to nerve-agent', () => {
    expect(deriveSurfaceDelegationReceiver('この設計をレビューして')).toBe('nerve-agent');
  });

  it('keeps lightweight greetings local', () => {
    expect(deriveSurfaceDelegationReceiver('こんにちは')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('thanks')).toBeUndefined();
  });

  it('keeps casual informational questions local unless they match heavy-work routing', () => {
    expect(deriveSurfaceDelegationReceiver('今日の天気おしえて')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('What is the weather today?')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('このsurfaceでは何ができるの？')).toBeUndefined();
  });
});
