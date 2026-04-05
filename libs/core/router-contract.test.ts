import { describe, expect, it } from 'vitest';
import { resolveSurfaceIntent } from './router-contract.js';
import { classifySurfaceQueryIntent } from './surface-query.js';
import { classifyBrowserConversationCommand } from './browser-conversation-session.js';

describe('router-contract', () => {
  it('routes direct replies through the shared intent resolver', () => {
    const knowledge = resolveSurfaceIntent('ナレッジで planner を調べて');
    const live = resolveSurfaceIntent('今日の天気を教えて');
    expect(knowledge.intentId).toBe('knowledge-query');
    expect(knowledge.queryType).toBe('knowledge_search');
    expect(live.intentId).toBe('live-query');
    expect(live.queryType).toBe('weather');
    expect(classifySurfaceQueryIntent('今日の天気を教えて')).toBe('weather');
  });

  it('routes browser intents through the shared resolver before command shaping', () => {
    const openSite = resolveSurfaceIntent('日経新聞を開いて');
    const browserStep = resolveSurfaceIntent('左下の承認ボタンを押して');
    expect(openSite.intentId).toBe('open-site');
    expect(openSite.browserCommandKind).toBe('open_site');
    expect(browserStep.intentId).toBe('browser-step');
    expect(browserStep.browserCommandKind).toBe('browser_step');
    expect(classifyBrowserConversationCommand('日経新聞を開いて')?.action).toBe('navigate');
    expect(classifyBrowserConversationCommand('左下の承認ボタンを押して')?.action).toBe('click');
  });
});
