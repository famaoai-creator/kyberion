import { describe, expect, it } from 'vitest';
import { resolveSurfaceIntent } from './router-contract.js';
import { classifySurfaceQueryIntent } from './surface-query.js';
import { classifyBrowserConversationCommand } from './browser-conversation-session.js';

describe('router-contract', () => {
  it('routes direct replies through the shared intent resolver', () => {
    const knowledge = resolveSurfaceIntent('ナレッジで planner を調べて');
    const live = resolveSurfaceIntent('今日の天気を教えて');
    expect(['knowledge-query', 'query-knowledge']).toContain(knowledge.intentId);
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

  it('emits pipeline and mission routing hints for governed process intents', () => {
    const baseline = resolveSurfaceIntent('Kyberionのベースライン状態を確認して');
    const createMission = resolveSurfaceIntent('ミッションを作成して');
    expect(baseline.intentId).toBe('check-kyberion-baseline');
    expect(baseline.shape).toBe('pipeline');
    expect(baseline.pipelineId).toBe('baseline-check');
    expect(createMission.intentId).toBe('create-mission');
    expect(createMission.shape).toBe('mission');
    expect(createMission.missionAction).toBe('create');
  });

  it('maps extended mission-process intents to direct mission actions', () => {
    const classify = resolveSurfaceIntent('classify-mission');
    const workflow = resolveSurfaceIntent('select-mission-workflow');
    const review = resolveSurfaceIntent('review-worker-output');
    const handoff = resolveSurfaceIntent('handoff-mission');
    const inspectState = resolveSurfaceIntent('inspect-mission-state');

    expect(classify.intentId).toBe('classify-mission');
    expect(classify.missionAction).toBe('classify');
    expect(workflow.intentId).toBe('select-mission-workflow');
    expect(workflow.missionAction).toBe('workflow');
    expect(review.intentId).toBe('review-worker-output');
    expect(review.missionAction).toBe('review_output');
    expect(handoff.intentId).toBe('handoff-mission');
    expect(handoff.missionAction).toBe('handoff');
    expect(inspectState.intentId).toBe('inspect-mission-state');
    expect(inspectState.missionAction).toBe('inspect_state');
  });

  it('maps environment readiness intents to governed pipeline hints', () => {
    const verify = resolveSurfaceIntent('verify-environment-readiness');
    const inspect = resolveSurfaceIntent('inspect-environment-readiness');
    const supervisor = resolveSurfaceIntent('inspect-runtime-supervisor');
    const audit = resolveSurfaceIntent('verify-audit-chain');
    expect(verify.intentId).toBe('verify-environment-readiness');
    expect(verify.pipelineId).toBe('baseline-check');
    expect(inspect.intentId).toBe('inspect-environment-readiness');
    expect(inspect.pipelineId).toBe('baseline-check');
    expect(supervisor.intentId).toBe('inspect-runtime-supervisor');
    expect(supervisor.pipelineId).toBe('system-diagnostics');
    expect(audit.intentId).toBe('verify-audit-chain');
    expect(audit.pipelineId).toBe('system-diagnostics');
  });
});
