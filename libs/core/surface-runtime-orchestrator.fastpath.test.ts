import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const safeExec = vi.fn();
  const secureFetch = vi.fn();
  const a2aRoute = vi.fn();
  const buildKnowledgeIndex = vi.fn();
  const queryKnowledge = vi.fn();
  const resolveSurfaceIntent = vi.fn();
  const compileUserIntentFlow = vi.fn();
  const classifyTaskSessionIntent = vi.fn();
  const createTaskSession = vi.fn();
  const saveTaskSession = vi.fn();
  return {
    safeExec,
    secureFetch,
    a2aRoute,
    buildKnowledgeIndex,
    queryKnowledge,
    resolveSurfaceIntent,
    compileUserIntentFlow,
    classifyTaskSessionIntent,
    createTaskSession,
    saveTaskSession,
  };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
  };
});

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: mocks.a2aRoute,
  },
}));

vi.mock('./intent-contract.js', () => ({
  compileUserIntentFlow: mocks.compileUserIntentFlow,
  formatClarificationPacket: vi.fn(() => 'clarification'),
}));

vi.mock('./network.js', () => ({
  secureFetch: mocks.secureFetch,
}));

vi.mock('./src/knowledge-index.js', () => ({
  buildKnowledgeIndex: mocks.buildKnowledgeIndex,
  queryKnowledge: mocks.queryKnowledge,
}));

vi.mock('./task-session.js', () => ({
  classifyTaskSessionIntent: mocks.classifyTaskSessionIntent,
  createTaskSession: mocks.createTaskSession,
  saveTaskSession: mocks.saveTaskSession,
}));

vi.mock('./router-contract.js', () => ({
  resolveSurfaceIntent: mocks.resolveSurfaceIntent,
}));

vi.mock('./surface-runtime-router.js', () => ({
  buildDelegationFallbackText: (query: string) => query,
  deriveSurfaceDelegationReceiver: () => undefined,
  normalizeSurfaceDelegationReceiver: () => undefined,
  parseSlackSurfacePrompt: () => null,
  resolveSurfaceConversationReceiver: () => undefined,
  shouldCompileSurfaceIntent: () => true,
  surfaceChannelFromAgentId: () => 'presence',
  surfaceRoutingText: (input: { query: string }) => ({ text: input.query, parsedSlackPrompt: null }),
}));

describe('surface-runtime-orchestrator fast-path', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.safeExec.mockReturnValue('ok');
    mocks.a2aRoute.mockResolvedValue({
      a2a_version: '1.0',
      header: {
        msg_id: 'RES-TEST',
        sender: 'browser-operator',
        receiver: 'test-sender',
        performative: 'result',
      },
      payload: {
        text: 'browser operator response',
      },
    });
    mocks.secureFetch.mockImplementation(async (options: { url?: string }) => {
      const url = String(options.url || '');
      if (url.includes('ipapi.co/json')) {
        return {
          city: 'Tokyo',
          region: 'Tokyo',
          country_name: 'Japan',
          latitude: 35.6762,
          longitude: 139.6503,
        };
      }
      if (url.includes('geocoding-api.open-meteo.com')) {
        return {
          results: [
            {
              name: 'Tokyo',
              latitude: 35.6762,
              longitude: 139.6503,
            },
          ],
        };
      }
      if (url.includes('api.open-meteo.com')) {
        return {
          current: {
            temperature_2m: 18.5,
            weather_code: 2,
            wind_speed_10m: 4.2,
            relative_humidity_2m: 62,
          },
        };
      }
      if (url.includes('html.duckduckgo.com')) {
        return [
          '<div class="result">',
          '<a class="result__a" href="https://example.com/result-1">Result One</a>',
          '<a class="result__snippet">Snippet One</a>',
          '</div>',
        ].join('');
      }
      return {};
    });
    mocks.buildKnowledgeIndex.mockResolvedValue({
      hints: [],
      builtAt: '2026-04-29T00:00:00.000Z',
    });
    mocks.queryKnowledge.mockReturnValue([
      {
        topic: 'mission authority',
        hint: 'Use the mission_controller classify command to inspect mission authority.',
        source: 'public/procedures/mission.md',
        confidence: 0.92,
        tags: ['mission', 'authority'],
      },
    ]);
    mocks.compileUserIntentFlow.mockResolvedValue({
      intentContract: { resolution: { execution_shape: 'pipeline' } },
      workLoop: {},
    });
    mocks.resolveSurfaceIntent.mockReturnValue({});
    mocks.classifyTaskSessionIntent.mockReturnValue(null);
    mocks.createTaskSession.mockImplementation((params: any) => ({
      session_id: 'TSK-TEST-SESSION',
      task_type: params.taskType,
      goal: params.goal,
      requirements: params.requirements,
      payload: params.payload,
      work_loop: {
        resolution: {
          execution_shape: 'task_session',
        },
      },
    }));
    mocks.saveTaskSession.mockReturnValue(undefined);
  });

  it('executes pipeline hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'check-kyberion-baseline',
      shape: 'pipeline',
      pipelineId: 'baseline-check',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'Kyberionのベースライン状態を確認して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Executed pipeline: baseline-check');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      ['dist/scripts/run_pipeline.js', '--input', 'pipelines/baseline-check.json'],
      expect.any(Object),
    );
  });

  it('executes mission action hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'classify-mission',
      shape: 'mission',
      missionAction: 'classify',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      missionId: 'MSN-TEST',
      query: 'ミッションを分類して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Executed mission action: classify (MSN-TEST)');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      ['dist/scripts/mission_controller.js', 'classify', 'MSN-TEST'],
      expect.any(Object),
    );
  });

  it('serves knowledge-query through the catalog-first direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'knowledge-query',
      shape: 'direct_reply',
      queryType: 'knowledge_search',
      queryText: 'mission authority',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'mission authority を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Knowledge results for: mission authority');
    expect(result.text).toContain('Provider: context_ranker');
    expect(result.text).toContain('mission authority');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      'mission authority',
      expect.objectContaining({ maxResults: 5 }),
    );
  });

  it('serves live-query weather through the provider-backed direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      queryType: 'weather',
      queryText: '東京の天気を教えて',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '東京の天気を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Weather for Tokyo');
    expect(result.text).toContain('Provider: open_meteo');
    expect(result.text).toContain('temperature 18.5°C');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://geocoding-api.open-meteo.com/v1/search',
      }),
    );
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.open-meteo.com/v1/forecast',
      }),
    );
  });

  it('serves live-query web search through the provider-backed direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      queryType: 'web_search',
      queryText: 'OpenAI Responses API',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'Webで OpenAI Responses API を検索して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Provider: duckduckgo_html');
    expect(result.text).toContain('Web search results for: OpenAI Responses API');
    expect(result.text).toContain('Result One');
  });

  it('creates a task session for schedule coordination requests', async () => {
    mocks.classifyTaskSessionIntent.mockReturnValue({
      intentId: 'schedule-coordination',
      taskType: 'service_operation',
      goal: {
        summary: 'Adjust the schedule',
        success_condition: 'Calendar constraints are reconciled',
      },
      requirements: {
        missing: ['schedule_scope', 'date_range'],
        collected: {},
      },
      payload: {
        handoff_intent_id: 'meeting-operations',
      },
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'スケジュールを調整して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Created task session: TSK-TEST-SESSION');
    expect(result.text).toContain('Intent: schedule-coordination');
    expect(result.text).toContain('Missing inputs: schedule_scope, date_range');
    expect(result.text).toContain('Handoff intent: meeting-operations');
    expect(mocks.saveTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'TSK-TEST-SESSION',
        task_type: 'service_operation',
      }),
    );
  });

  it('creates a task session for cross-project remediation requests', async () => {
    mocks.classifyTaskSessionIntent.mockReturnValue({
      intentId: 'cross-project-remediation',
      taskType: 'analysis',
      goal: {
        summary: 'Review propagation gaps',
        success_condition: 'A remediation plan exists',
      },
      requirements: {
        missing: [],
        collected: {},
      },
      payload: {
        source_corpus: 'requirements',
        action_bias: 'remediation',
      },
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '過去の要件定義を横断的に見て横展開されていないバグを修正して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Created task session: TSK-TEST-SESSION');
    expect(result.text).toContain('Intent: cross-project-remediation');
    expect(result.text).toContain('No missing inputs were detected.');
    expect(mocks.saveTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'TSK-TEST-SESSION',
        task_type: 'analysis',
      }),
    );
  });

  it('delegates open-site to the browser operator route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'open-site',
      shape: 'browser_session',
      browserCommandKind: 'open_site',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '日経新聞を開いて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('browser operator response');
    expect(mocks.a2aRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({
          receiver: 'browser-operator',
          sender: 'test-sender',
        }),
        payload: expect.objectContaining({
          intent: 'surface_handoff',
          text: '日経新聞を開いて',
        }),
      }),
    );
  });

  it('delegates browser-step to the browser operator route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'browser-step',
      shape: 'browser_session',
      browserCommandKind: 'browser_step',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '左下の承認ボタンを押して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('browser operator response');
    expect(mocks.a2aRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({
          receiver: 'browser-operator',
          sender: 'test-sender',
        }),
        payload: expect.objectContaining({
          intent: 'surface_handoff',
          text: '左下の承認ボタンを押して',
        }),
      }),
    );
  });
});
