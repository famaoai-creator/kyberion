import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockTaskSession = {
  session_id: string;
  task_type: string;
  status: string;
  goal: { summary: string; success_condition: string };
  payload: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  artifact?: Record<string, unknown>;
};

const generateWithTools = vi.fn();
const taskSessionMocks = vi.hoisted(() => {
  const sessions = new Map<string, MockTaskSession>();
  return {
    sessions,
    reset: () => sessions.clear(),
    createTaskSession: vi.fn(
      (input: {
        taskType: string;
        status: string;
        goal: MockTaskSession['goal'];
        payload?: Record<string, unknown>;
      }): MockTaskSession => ({
        session_id: 'TSK-BROWSER-TEST',
        task_type: input.taskType,
        status: input.status,
        goal: input.goal,
        payload: input.payload || {},
        history: [],
      })
    ),
    loadTaskSession: vi.fn((id: string) => sessions.get(id) || null),
    saveTaskSession: vi.fn((session: MockTaskSession) => {
      sessions.set(session.session_id, session);
      return `active/shared/runtime/task-sessions/${session.session_id}.json`;
    }),
    updateTaskSession: vi.fn((id: string, patch: Partial<MockTaskSession>) => {
      const current = sessions.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, session_id: id };
      sessions.set(id, next);
      return next;
    }),
    recordTaskSessionHistory: vi.fn((id: string, entry: Record<string, unknown>) => {
      const current = sessions.get(id);
      if (!current) return null;
      const next = {
        ...current,
        history: [...(current.history || []), entry],
      };
      sessions.set(id, next);
      return next;
    }),
  };
});
vi.mock('@agent/core/reasoning/reasoning-backend', () => ({
  getReasoningBackend: () => ({ generateWithTools }),
}));
vi.mock('@agent/core/task/task-session', () => ({
  createTaskSession: taskSessionMocks.createTaskSession,
  loadTaskSession: taskSessionMocks.loadTaskSession,
  recordTaskSessionHistory: taskSessionMocks.recordTaskSessionHistory,
  saveTaskSession: taskSessionMocks.saveTaskSession,
  updateTaskSession: taskSessionMocks.updateTaskSession,
}));

import {
  completeBrowserPipelineReplay,
  prepareBrowserPipelineReplay,
  runBrowserAssist,
} from './browser-assist.js';

const input = {
  goal: 'Open the Rakuten homepage',
  max_actions: 4,
  allowed_origins: ['https://www.rakuten.co.jp'],
};

function snapshot(url = 'about:blank') {
  return {
    status: 'succeeded',
    context: {
      last_snapshot: {
        url,
        title: url === 'about:blank' ? 'New Tab' : 'Rakuten',
        ready_state: 'complete',
        elements: [
          {
            ref: '@e1',
            role: 'searchbox',
            name: '商品を検索',
            text: '',
            type: 'search',
            placeholder: '商品名を入力',
            href: null,
            value: '',
            value_redacted: false,
            visible: true,
            editable: true,
            selector: 'input[type="search"]',
          },
        ],
      },
    },
  };
}

describe('browser assist exploration loop', () => {
  beforeEach(() => {
    generateWithTools.mockReset();
    taskSessionMocks.reset();
    taskSessionMocks.createTaskSession.mockClear();
    taskSessionMocks.loadTaskSession.mockClear();
    taskSessionMocks.saveTaskSession.mockClear();
    taskSessionMocks.updateTaskSession.mockClear();
    taskSessionMocks.recordTaskSessionHistory.mockClear();
  });

  it('observes again after each action and returns an unapproved deterministic pipeline draft', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'navigate', url: 'https://www.rakuten.co.jp/' },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'complete', reason: 'The Rakuten page is visible.' },
          },
        ],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'));

    const result = await runBrowserAssist(input, { executePipeline });

    expect(generateWithTools).toHaveBeenCalledTimes(2);
    expect(executePipeline).toHaveBeenCalledTimes(3);
    expect(executePipeline.mock.calls[1]?.[0]).toEqual([
      {
        id: 'step-1',
        type: 'apply',
        op: 'goto',
        params: {
          url: 'https://www.rakuten.co.jp/',
          waitUntil: 'domcontentloaded',
        },
      },
    ]);
    expect(result).toMatchObject({
      status: 'completed',
      task_session_id: 'TSK-BROWSER-TEST',
      pipeline_candidate: {
        _draft: true,
        steps: [{ op: 'goto', params: { url: 'https://www.rakuten.co.jp/' } }],
        _review_required: expect.any(Array),
      },
    });
    expect(taskSessionMocks.sessions.get('TSK-BROWSER-TEST')).toMatchObject({
      status: 'verifying',
      artifact: {
        kind: 'browser_pipeline_candidate',
        browser_pipeline_candidate: expect.any(Object),
      },
      payload: { workflow_stage: 'awaiting_pipeline_review' },
    });
  });

  it('stops when a proposed navigation leaves the explicitly allowed origins', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [
        {
          name: 'browser_action',
          input: { type: 'navigate', url: 'https://example.com/' },
        },
      ],
    });
    const executePipeline = vi.fn().mockResolvedValue(snapshot());

    await expect(runBrowserAssist(input, { executePipeline })).rejects.toThrow(
      /refused navigation outside/
    );
    expect(executePipeline).toHaveBeenCalledTimes(1);
  });

  it('refuses purchase controls and password fields before execution', async () => {
    generateWithTools.mockResolvedValue({
      toolCalls: [{ name: 'browser_action', input: { type: 'click_ref', ref: '@e2' } }],
    });
    const purchaseSnapshot = {
      status: 'succeeded',
      context: {
        last_snapshot: {
          ...snapshot().context.last_snapshot,
          elements: [
            {
              ...snapshot().context.last_snapshot.elements[0],
              ref: '@e2',
              role: 'button',
              name: '購入する',
              editable: false,
            },
          ],
        },
      },
    };
    const executePipeline = vi.fn().mockResolvedValue(purchaseSnapshot);

    await expect(runBrowserAssist(input, { executePipeline })).rejects.toThrow(
      /purchase or checkout/
    );
    expect(executePipeline).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or noncanonical origin allowlists', async () => {
    const executePipeline = vi.fn();
    await expect(runBrowserAssist({ goal: input.goal }, { executePipeline })).rejects.toThrow(
      /explicitly allowed HTTPS origins/
    );
    expect(executePipeline).not.toHaveBeenCalled();
  });

  it('extracts page text and feeds it into the next model turn before finishing a deal search', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'navigate', url: 'https://www.rakuten.co.jp/' },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [{ name: 'browser_action', input: { type: 'extract_page_text' } }],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: {
              type: 'complete',
              summary: '20% point back on a pack of rice.',
            },
          },
        ],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'))
      .mockResolvedValueOnce({
        status: 'succeeded',
        context: { page_text_2: '20% point back: pack of rice' },
      })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'));

    const result = await runBrowserAssist(
      { ...input, goal: 'Find a good deal and its price on Rakuten' },
      { executePipeline }
    );

    expect(generateWithTools).toHaveBeenCalledTimes(3);
    expect(generateWithTools.mock.calls[2]?.[0]).toContain('20% point back: pack of rice');
    expect(result).toMatchObject({
      status: 'completed',
      summary: '20% point back on a pack of rice.',
      pipeline_candidate: {
        steps: [{ op: 'goto' }, { op: 'content', params: { selector: 'body' } }],
      },
    });
  });

  it('pauses and preserves the candidate when the model proposes an unsupported action', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'navigate', url: 'https://www.rakuten.co.jp/' },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [{ name: 'browser_action', input: { type: 'activate_app' } }],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'));

    const result = await runBrowserAssist(input, { executePipeline });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      reason: expect.stringContaining('unsupported browser action'),
      pipeline_candidate: { steps: [{ op: 'goto' }] },
    });
    expect(taskSessionMocks.sessions.get('TSK-BROWSER-TEST')).toMatchObject({
      status: 'paused',
      payload: { workflow_stage: 'invalid_model_action' },
      artifact: { kind: 'browser_pipeline_candidate' },
    });
    expect(executePipeline).toHaveBeenCalledTimes(3);
  });

  it('stops on a repeated page-text extraction and preserves the existing evidence', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [{ name: 'browser_action', input: { type: 'extract_page_text' } }],
      })
      .mockResolvedValueOnce({
        toolCalls: [{ name: 'browser_action', input: { type: 'extract_page_text' } }],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'))
      .mockResolvedValueOnce({
        status: 'succeeded',
        context: { page_text_1: 'Observed deal: 20% points back' },
      })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'));

    const result = await runBrowserAssist(
      { ...input, goal: 'Find a product deal and its price' },
      { executePipeline }
    );

    expect(result).toMatchObject({
      status: 'needs_clarification',
      actions: [{ extracted_text: 'Observed deal: 20% points back' }],
      pipeline_candidate: {
        steps: [{ op: 'content', params: { selector: 'body' } }],
      },
    });
    expect(executePipeline).toHaveBeenCalledTimes(3);
  });

  it('adds fresh snapshots before ref-based actions in the replay candidate', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'navigate', url: 'https://www.rakuten.co.jp/' },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [{ name: 'browser_action', input: { type: 'click_ref', ref: '@e1' } }],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'complete', reason: 'Opened the deal page.' },
          },
        ],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'))
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/superdeal/'));

    const result = await runBrowserAssist(input, { executePipeline });

    expect(result.pipeline_candidate.steps).toEqual([
      expect.objectContaining({ op: 'goto' }),
      expect.objectContaining({
        op: 'snapshot',
        params: { export_as: 'last_snapshot' },
      }),
      expect.objectContaining({
        op: 'click_ref',
        params: { ref: '@e1', name: expect.any(String), role: 'searchbox' },
      }),
    ]);
  });

  it('completes the linked task session only when the exact candidate replays in a fresh session', async () => {
    generateWithTools
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'navigate', url: 'https://www.rakuten.co.jp/' },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            name: 'browser_action',
            input: { type: 'complete', reason: 'The page is open.' },
          },
        ],
      });
    const executePipeline = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce({ status: 'succeeded' })
      .mockResolvedValueOnce(snapshot('https://www.rakuten.co.jp/'));
    const exploration = await runBrowserAssist(input, { executePipeline });
    const candidate = exploration.pipeline_candidate;

    expect(() =>
      prepareBrowserPipelineReplay({
        task_session_id: exploration.task_session_id,
        session_id: exploration.session_id,
        steps: candidate.steps,
        options: candidate.options,
      })
    ).toThrow(/fresh browser session/);
    expect(taskSessionMocks.sessions.get(exploration.task_session_id).status).toBe('verifying');

    const linkedSession = prepareBrowserPipelineReplay({
      task_session_id: exploration.task_session_id,
      session_id: 'browser-replay-fresh',
      steps: candidate.steps,
      options: candidate.options,
    });
    completeBrowserPipelineReplay(
      linkedSession,
      { status: 'succeeded', context: { url: 'https://www.rakuten.co.jp/' } },
      'browser-replay-fresh'
    );

    expect(taskSessionMocks.sessions.get(exploration.task_session_id)).toMatchObject({
      status: 'completed',
      artifact: {
        kind: 'browser_pipeline_replay',
        replay_session_id: 'browser-replay-fresh',
      },
      payload: {
        workflow_stage: 'completed',
        replay_session_id: 'browser-replay-fresh',
      },
    });
  });
});
