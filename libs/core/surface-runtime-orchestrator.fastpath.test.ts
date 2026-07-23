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
  const updateTaskSession = vi.fn();
  const getActiveTaskSession = vi.fn();
  const surfaceChannelFromAgentId = vi.fn(() => 'presence');
  const executeCapturePhotoTaskSession = vi.fn();
  const recordExecutionFeedback = vi.fn();
  const parseExecutionFeedbackText = vi.fn();
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
    updateTaskSession,
    getActiveTaskSession,
    surfaceChannelFromAgentId,
    executeCapturePhotoTaskSession,
    recordExecutionFeedback,
    parseExecutionFeedbackText,
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
  DEFAULT_SCOPE: { tiers: ['public'] },
  buildKnowledgeIndex: mocks.buildKnowledgeIndex,
  buildScopedIndex: mocks.buildKnowledgeIndex,
  queryKnowledge: mocks.queryKnowledge,
  queryKnowledgeHybrid: mocks.queryKnowledge,
}));

vi.mock('./task-session.js', () => ({
  classifyTaskSessionIntent: mocks.classifyTaskSessionIntent,
  createTaskSession: mocks.createTaskSession,
  saveTaskSession: mocks.saveTaskSession,
  updateTaskSession: mocks.updateTaskSession,
  getActiveTaskSession: mocks.getActiveTaskSession,
}));

vi.mock('./capture-photo-task-session-executor.js', () => ({
  executeCapturePhotoTaskSession: mocks.executeCapturePhotoTaskSession,
}));

vi.mock('./execution-feedback.js', () => ({
  recordExecutionFeedback: mocks.recordExecutionFeedback,
  parseExecutionFeedbackText: mocks.parseExecutionFeedbackText,
}));

vi.mock('./router-contract.js', () => ({
  resolveSurfaceIntent: mocks.resolveSurfaceIntent,
  resolveDirectIntentCommand: () => null,
}));

vi.mock('./surface-runtime-router.js', () => ({
  buildDelegationFallbackText: (query: string) => query,
  deriveSurfaceDelegationReceiver: () => undefined,
  normalizeSurfaceDelegationReceiver: () => undefined,
  parseSlackSurfacePrompt: () => null,
  resolveSurfaceConversationReceiver: () => undefined,
  shouldCompileSurfaceIntent: () => true,
  surfaceChannelFromAgentId: mocks.surfaceChannelFromAgentId,
  surfaceRoutingText: (input: { query: string }) => ({
    text: input.query,
    parsedSlackPrompt: null,
  }),
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
      if (url.includes('ipwho.is')) {
        return {
          city: 'Tokyo',
          region: 'Tokyo',
          country: 'Japan',
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
    mocks.executeCapturePhotoTaskSession.mockResolvedValue({
      output: '写真を取得しました。\n使用カメラ: FaceTime HD Camera\n保存先: /tmp/capture.jpg',
      outputPath: '/tmp/capture.jpg',
      session: {
        session_id: 'TSK-TEST-SESSION',
        task_type: 'capture_photo',
        goal: {
          summary: '記録用の写真を撮る',
          success_condition: '画像が保存される',
        },
        artifact: {
          kind: 'image',
          output_path: '/tmp/capture.jpg',
          preview_text: '写真を取得しました。',
          storage_class: 'tmp',
        },
        work_loop: {
          resolution: {
            execution_shape: 'task_session',
          },
        },
      },
    });
    mocks.recordExecutionFeedback.mockReturnValue({
      kind: 'execution-feedback',
      schema_version: '1.0.0',
      feedback_id: 'FB-TEST',
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'partially_satisfied',
      source: 'user',
      recorded_at: '2026-07-23T00:00:00.000Z',
    });
    mocks.parseExecutionFeedbackText.mockReturnValue(null);
  });

  it('executes pipeline hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'check-kyberion-baseline',
      shape: 'pipeline',
      routeFamily: 'pipeline',
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
    // IL-01: the interpreted goal rides along as a --context payload when
    // the surface utterance is available.
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining([
        'dist/scripts/run_pipeline.js',
        '--input',
        'pipelines/baseline-check.json',
      ]),
      expect.any(Object)
    );
    const pipelineArgs = mocks.safeExec.mock.calls.find(
      (call: unknown[]) =>
        Array.isArray(call[1]) && (call[1] as string[]).includes('dist/scripts/run_pipeline.js')
    )?.[1] as string[];
    const contextIndex = pipelineArgs.indexOf('--context');
    if (contextIndex >= 0) {
      expect(JSON.parse(pipelineArgs[contextIndex + 1]).intent_goal).toBeDefined();
    }
  });

  it('executes mission action hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'classify-mission',
      shape: 'mission',
      routeFamily: 'mission',
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
      expect.any(Object)
    );
  });

  it('serves knowledge-query through the catalog-first direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'knowledge-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'knowledge_search',
      queryText: 'mission authority',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'mission authority を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain(
      'Here is the short summary from context_ranker: I found 1 item(s).'
    );
    expect(result.text).toContain('- mission authority');
    expect(result.text).toContain("If you'd like, I can narrow this down further.");
    expect(result.text).toContain('Completion: Completion confirmed');
    expect(mocks.queryKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      'mission authority',
      expect.objectContaining({ maxResults: 5 })
    );
  });

  it('serves live-query weather through the provider-backed direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'weather',
      queryText: '東京の天気を教えて',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '東京の天気を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Weather for Tokyo:');
    expect(result.text).toContain('temperature 18.5°C');
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://geocoding-api.open-meteo.com/v1/search',
      })
    );
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.open-meteo.com/v1/forecast',
      })
    );
  });

  it('falls back to ipwho when ipapi is unavailable for current location queries', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'location',
      queryText: '現在地を教えて',
    });
    mocks.secureFetch.mockImplementation(async (options: { url?: string }) => {
      const url = String(options.url || '');
      if (url.includes('ipapi.co/json')) {
        throw new Error('ipapi blocked');
      }
      if (url.includes('ipwho.is')) {
        return {
          city: 'Tokyo',
          region: 'Tokyo',
          country: 'Japan',
          latitude: 35.6762,
          longitude: 139.6503,
        };
      }
      return {};
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '現在地を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Current location: Tokyo, Tokyo, Japan');
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ipapi.co/json/',
      })
    );
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ipwho.is/',
      })
    );
  });

  it('falls back to current-location coordinates when geocoding fails for weather queries', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'weather',
      queryText: '大阪の天気を教えて',
    });
    mocks.secureFetch.mockImplementation(async (options: { url?: string }) => {
      const url = String(options.url || '');
      if (url.includes('geocoding-api.open-meteo.com')) {
        return { results: [] };
      }
      if (url.includes('ipapi.co/json')) {
        throw new Error('ipapi blocked');
      }
      if (url.includes('ipwho.is')) {
        return {
          city: 'Tokyo',
          region: 'Tokyo',
          country: 'Japan',
          latitude: 35.6762,
          longitude: 139.6503,
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
      return {};
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '大阪の天気を教えて',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Weather for Tokyo, Tokyo, Japan:');
    expect(result.text).toContain('temperature 18.5°C');
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://geocoding-api.open-meteo.com/v1/search',
      })
    );
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ipwho.is/',
      })
    );
  });

  it('serves live-query web search through the provider-backed direct reply route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'web_search',
      queryText: 'OpenAI Responses API',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'Webで OpenAI Responses API を検索して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Web search results for: OpenAI Responses API');
    expect(result.text).toContain('Result One');
  });

  it('passes the resolved surface channel into intent compilation for non-slack surfaces', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'knowledge_search',
      queryText: 'mission authority',
    });
    mocks.surfaceChannelFromAgentId.mockReturnValue('imessage');
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await runSurfaceConversation({
      agentId: 'imessage-surface-agent',
      query: 'mission authority を教えて',
      senderAgentId: 'test-sender',
    });
    expect(mocks.compileUserIntentFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'imessage',
      })
    );
  });

  it('includes the compiled use-case scenario in the governed Surface context', async () => {
    const scenario = {
      kind: 'intent-use-case-scenario',
      scenario_id: 'use-case-schedule-read-agenda',
      handoff: { status: 'ready', next_action: 'execute' },
    };
    const { buildSurfaceStructuredQuery } = await import('./surface-runtime-orchestrator.js');
    const structuredQuery = buildSurfaceStructuredQuery('来週の予定を教えて', {
      executionBrief: { workflow_steps: [] },
      intentContract: { resolution: { execution_shape: 'direct_reply' } },
      workLoop: {},
      useCaseScenario: scenario,
    } as any);

    expect(structuredQuery).toContain(
      'Governed use-case scenario (canonical user-facing handoff):'
    );
    expect(structuredQuery).toContain('use-case-schedule-read-agenda');
    expect(structuredQuery).toContain('Follow the scenario handoff:');
  });

  it('offers structured feedback after a compiled scenario response', async () => {
    mocks.compileUserIntentFlow.mockResolvedValue({
      intentContract: { resolution: { execution_shape: 'direct_reply' } },
      workLoop: {},
      executionBrief: { workflow_steps: [] },
      useCaseScenario: {
        kind: 'intent-use-case-scenario',
        scenario_id: 'use-case-compiled-surface',
        intent_id: 'compiled-surface',
        handoff: { status: 'ready', next_action: 'execute' },
      },
    });
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'live-query',
      shape: 'direct_reply',
      routeFamily: 'direct_reply',
      queryType: 'knowledge_search',
      queryText: 'compiled surface feedback',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'この長い依頼をシナリオに沿って確認して'.repeat(8),
      senderAgentId: 'test-sender',
    });

    expect(result.text).toContain('評価: このシナリオを改善する場合');
    expect(result.executionFeedbackRequest).toMatchObject({
      scenario_id: 'use-case-compiled-surface',
      intent_id: 'compiled-surface',
      structured: true,
    });
  });

  it('records structured user feedback without rerunning the scenario', async () => {
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '一部違います',
      senderAgentId: 'test-sender',
      executionFeedback: {
        scenario_id: 'use-case-schedule-read-agenda',
        intent_id: 'schedule-read-agenda',
        outcome: 'partially_satisfied',
        correction: '予定の対象期間を確認してから取得してほしい',
      },
    });

    expect(mocks.recordExecutionFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario_id: 'use-case-schedule-read-agenda',
        outcome: 'partially_satisfied',
      })
    );
    expect(result.text).toContain('評価を記録しました');
    expect(mocks.compileUserIntentFlow).not.toHaveBeenCalled();
  });

  it('records the text fallback form of user feedback', async () => {
    mocks.parseExecutionFeedbackText.mockReturnValue({
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'partially_satisfied',
      correction: '期間を確認して',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '評価 use-case-schedule-read-agenda: 一部違う: 期間を確認して',
      senderAgentId: 'test-sender',
    });

    expect(mocks.recordExecutionFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        scenario_id: 'use-case-schedule-read-agenda',
        intent_id: 'schedule-read-agenda',
        outcome: 'partially_satisfied',
        correction: '期間を確認して',
      })
    );
  });

  it('threads iMessage context into intent compilation', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'schedule-coordination',
      shape: 'task_session',
      routeFamily: 'direct_reply',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await runSurfaceConversation({
      agentId: 'imessage-surface-agent',
      surface: 'imessage',
      query: 'では夕方にー！',
      surfaceText: 'では夕方にー！',
      threadContext: 'User: 今夜のお店は予定表に入れています。',
      senderAgentId: 'kyberion:imessage-bridge',
    } as any);
    // Since the simple-conversation bypass (d4169ad1) the thread context is
    // threaded structurally via runtimeContext instead of inlined into text.
    expect(mocks.compileUserIntentFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'では夕方にー！',
        runtimeContext: expect.objectContaining({
          thread_context: expect.stringContaining('今夜のお店は予定表に入れています'),
        }),
      })
    );
  });

  it('backtracks to the last filled slot on a correction utterance (IL-05 Task 2)', async () => {
    const session = {
      session_id: 'TSK-CORRECTION',
      surface: 'presence',
      task_type: 'service_operation',
      status: 'collecting_requirements',
      goal: { summary: 'adjust schedule', success_condition: 'reconciled' },
      payload: { intent_id: 'schedule-coordination', schedule_scope: '来週の定例' },
      requirements: {
        missing: ['date_range'],
        collected: {},
        filled_order: ['schedule_scope'],
      },
    };
    mocks.getActiveTaskSession.mockReturnValue(session as any);
    mocks.updateTaskSession.mockImplementation((_id: string, patch: any) => ({
      ...session,
      ...patch,
    }));
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '違う、そうじゃない',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('schedule_scope を修正します');
    expect(mocks.updateTaskSession).toHaveBeenCalledWith(
      'TSK-CORRECTION',
      expect.objectContaining({
        requirements: expect.objectContaining({
          missing: ['schedule_scope', 'date_range'],
          filled_order: [],
        }),
      })
    );
    const patch = mocks.updateTaskSession.mock.calls[0][1];
    expect(patch.payload.schedule_scope).toBeUndefined();
    // clearAllMocks does not clear implementations — restore the defaults so
    // later tests do not inherit this active session.
    mocks.getActiveTaskSession.mockReset();
    mocks.updateTaskSession.mockReset();
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
    expect(result.text).toContain('短い作業として進めます。');
    expect(result.text).toContain('予定の確認を進めます。');
    expect(result.text).toContain('確認したい点があります: 対象、期間');
    expect(result.text).toContain('必要なら会議調整まで引き継げます。');
    expect(mocks.saveTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'TSK-TEST-SESSION',
        task_type: 'service_operation',
      })
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
    expect(result.text).toContain('確認を進めます。');
    expect(result.text).toContain('必要な情報はそろっています。');
    expect(mocks.saveTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'TSK-TEST-SESSION',
        task_type: 'analysis',
      })
    );
  });

  it('logs omitted counts for long external-data fetch summaries', async () => {
    mocks.classifyTaskSessionIntent.mockReturnValue({
      intentId: 'fetch-external-data',
      taskType: 'service_operation',
      goal: {
        summary: 'Collect the external page text',
        success_condition: 'A summarized artifact is saved',
      },
      requirements: {
        missing: [],
        collected: {
          source_url: 'https://example.com/long',
        },
      },
      payload: {
        source_url: 'https://example.com/long',
        data_topic: 'Long article',
        service_id_hint: 'long-article',
      },
    });
    mocks.secureFetch.mockResolvedValueOnce(`<article>${'x'.repeat(5000)}</article>`);
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'この長い記事を要約して',
      senderAgentId: 'test-sender',
    });

    expect(result.text).toContain('...(以降 2500 文字省略)');
    expect(mocks.updateTaskSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        artifact: expect.objectContaining({
          omitted_count: 3500,
        }),
      })
    );
  });

  it('promotes a task-session route to mission creation when the work-scope policy requires it', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'pptx-theme-import',
      shape: 'task_session',
      routeFamily: 'task_session',
    });
    mocks.compileUserIntentFlow.mockResolvedValue({
      intentContract: { resolution: { execution_shape: 'task_session' } },
      workLoop: {
        work_scope_decision: {
          execution_shape: 'mission',
          minimum_catalog_shape: 'task_session',
          promotion_required: true,
          mandatory_triggers: [],
          accumulation_triggers: ['artifact_estimate_5plus', 'stakeholder_count_3plus'],
          matched_rule_ids: ['accumulation-trigger-promotion'],
          policy_version: '1.0.0',
          rationale: 'Policy threshold was met.',
        },
      },
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'PPTX のテーマを取り込んで再現して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('承認と記録が必要なためミッションとして進めます。');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(result.text).toContain('"governance"');
    expect(result.text).toContain('"policy_version": "1.0.0"');
    expect(result.text).toContain('"accumulation-trigger-promotion"');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['dist/scripts/mission_controller.js', 'create']),
      expect.any(Object)
    );
    expect(mocks.createTaskSession).not.toHaveBeenCalled();
  });

  it('executes capture_photo task sessions through the virtual camera bridge path', async () => {
    mocks.classifyTaskSessionIntent.mockReturnValue({
      intentId: 'capture-photo',
      taskType: 'capture_photo',
      goal: {
        summary: '記録用の写真を撮る',
        success_condition: '画像が保存される',
      },
      requirements: {
        missing: [],
        collected: {
          camera_intent: 'record',
        },
      },
      payload: {
        camera_intent: 'record',
        camera_device_preference: 'FaceTime HD Camera',
      },
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '記録用に写真を1枚撮って',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('写真を取得しました。');
    expect(result.text).toContain('使用カメラ: FaceTime HD Camera');
    expect(result.text).toContain('保存先: /tmp/capture.jpg');
    expect(result.text).toContain('Completion: Completion confirmed');
    expect(mocks.executeCapturePhotoTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          task_type: 'capture_photo',
        }),
        queryText: '記録用に写真を1枚撮って',
      })
    );
  });

  it('delegates open-site to the browser operator route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'open-site',
      shape: 'browser_session',
      routeFamily: 'browser_session',
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
      })
    );
  });

  it('delegates browser-step to the browser operator route', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'browser-step',
      shape: 'browser_session',
      routeFamily: 'browser_session',
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
      })
    );
  });

  it('progressively fills slots when an active session is missing requirements', async () => {
    mocks.getActiveTaskSession
      .mockReturnValueOnce({
        session_id: 'TSK-ACTIVE-1',
        task_type: 'service_operation',
        requirements: { missing: ['requestId'] },
        payload: { intent_id: 'resolve-approval', channel: 'slack', decision: 'approve' },
        goal: 'resolve approval request',
      })
      .mockReturnValueOnce({
        session_id: 'TSK-ACTIVE-1',
        task_type: 'service_operation',
        requirements: { missing: ['requestId'] },
        payload: { intent_id: 'resolve-approval', channel: 'slack', decision: 'approve' },
        goal: 'resolve approval request',
      });
    mocks.getActiveTaskSession.mockReturnValue(null); // Prevent subsequent loop match

    mocks.updateTaskSession.mockReturnValue({
      session_id: 'TSK-ACTIVE-1',
      task_type: 'service_operation',
      requirements: { missing: [] },
      payload: {
        intent_id: 'resolve-approval',
        channel: 'slack',
        decision: 'approve',
        requestId: 'REQ-FINAL-789',
      },
      status: 'planning',
      goal: 'resolve approval request',
    });

    mocks.safeExec.mockReturnValue(JSON.stringify({ ok: true, status: 'approved' }));

    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'REQ-FINAL-789',
      senderAgentId: 'test-sender',
    });

    expect(result.text).toContain('オペレーション [resolve-approval] が正常に完了しました。');
    expect(mocks.updateTaskSession).toHaveBeenCalledWith(
      'TSK-ACTIVE-1',
      expect.objectContaining({
        payload: expect.objectContaining({ requestId: 'REQ-FINAL-789' }),
        requirements: expect.objectContaining({ missing: [] }),
      })
    );
  });

  it('routes voice input toggle tasks through the system actuator', async () => {
    mocks.classifyTaskSessionIntent.mockReturnValue({
      taskType: 'service_operation',
      intentId: 'enable-voice-input',
      goal: {
        summary: 'Switch Kyberion to voice input mode',
        success_condition: 'Voice input is enabled.',
      },
      requirements: { missing: [] },
      payload: {
        intent_id: 'enable-voice-input',
        service_name: 'voice-hub',
        operation: 'voice_input_toggle',
        dictation_keycode: 176,
      },
    });
    mocks.createTaskSession.mockImplementation((input: any) => ({
      session_id: 'TSK-VOICE-1',
      task_type: input.taskType,
      requirements: { missing: [] },
      payload: input.payload,
      goal: input.goal,
      work_loop: { resolution: { execution_shape: 'task_session' } },
    }));
    mocks.updateTaskSession.mockImplementation((sessionId: string, update: any) => ({
      session_id: sessionId,
      task_type: 'service_operation',
      requirements: update.requirements || { missing: [] },
      payload: update.payload || { intent_id: 'enable-voice-input' },
      goal: {
        summary: 'Switch Kyberion to voice input mode',
        success_condition: 'Voice input is enabled.',
      },
      status: update.status,
    }));
    mocks.safeExec.mockReturnValue(JSON.stringify({ ok: true, status: 'voice_input_enabled' }));

    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '音声入力にして',
      senderAgentId: 'test-sender',
    });

    expect(result.text).toContain('音声入力を有効化しました');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      [
        'dist/libs/actuators/system-actuator/src/index.js',
        '--input',
        expect.stringContaining('input-TSK-VOICE-1.json'),
      ],
      expect.objectContaining({ cwd: expect.any(String) })
    );
  });
});
