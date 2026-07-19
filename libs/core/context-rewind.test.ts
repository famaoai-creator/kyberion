import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const recordGovernanceAction = vi.fn();
vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
}));

import {
  MAX_REWIND_LESSON_CHARS,
  RewindableWorkerContext,
  buildContextRewindToolDefinition,
} from './context-rewind.js';
import {
  getDefaultWorkerEventStream,
  resetDefaultWorkerEventStream,
} from './worker-event-stream.js';

beforeEach(() => {
  recordGovernanceAction.mockClear();
  resetDefaultWorkerEventStream();
});

function seededContext(): { context: RewindableWorkerContext; checkpointId: string } {
  const context = new RewindableWorkerContext(
    [
      { role: 'user', content: 'goal: fix the failing build' },
      { role: 'assistant', content: 'plan: inspect the config' },
    ],
    'MSN-REWIND-1'
  );
  context.beginTurn();
  const checkpointId = context.checkpoint();
  context.append({ role: 'assistant', content: 'try approach A (tool call)' });
  context.append({ role: 'user', content: 'tool_result: approach A failed' });
  context.append({ role: 'assistant', content: 'retry approach A slightly differently' });
  context.append({ role: 'user', content: 'tool_result: failed again' });
  return { context, checkpointId };
}

describe('RewindableWorkerContext (KC-07 acceptance)', () => {
  it('rewinds a dead-end exploration: failed tool traffic gone, only the lesson remains', () => {
    const { context, checkpointId } = seededContext();
    const result = context.rewindTo(checkpointId, 'Approach A cannot work: the config is generated.');

    expect(result).toEqual({ rewound: true, droppedMessages: 4 });
    const contents = context.getMessages().map((message) => message.content);
    expect(contents.some((content) => content.includes('approach A failed'))).toBe(false);
    expect(contents.at(-1)).toContain('Approach A cannot work');
    expect(contents.at(-1)).toContain('<system-reminder>');
    expect(contents[0]).toContain('goal: fix the failing build');
  });

  it('refuses to rewind across a recorded external effect', () => {
    const { context, checkpointId } = seededContext();
    context.recordExternalEffect('wrote config file');

    const result = context.rewindTo(checkpointId, 'lesson');
    expect(result).toEqual({ rewound: false, refusal: 'external_effects_since_checkpoint' });
    expect(context.getMessages()).toHaveLength(6);
  });

  it('allows at most one rewind per turn, re-armed by beginTurn', () => {
    const { context, checkpointId } = seededContext();
    expect(context.rewindTo(checkpointId, 'lesson one').rewound).toBe(true);

    const again = context.checkpoint();
    context.append({ role: 'assistant', content: 'another dead end' });
    expect(context.rewindTo(again, 'lesson two')).toEqual({
      rewound: false,
      refusal: 'rewind_already_used_this_turn',
    });

    context.beginTurn();
    expect(context.rewindTo(again, 'lesson two').rewound).toBe(true);
  });

  it('preserves pinned (carryover) messages through a rewind', () => {
    const { context, checkpointId } = seededContext();
    context.append({ role: 'user', content: '<task_focus_state>carryover</task_focus_state>', pinned: true });

    const result = context.rewindTo(checkpointId, 'lesson');
    expect(result.rewound).toBe(true);
    const contents = context.getMessages().map((message) => message.content);
    expect(contents.some((content) => content.includes('carryover'))).toBe(true);
  });

  it('caps the lesson length and rejects unknown checkpoints', () => {
    const { context, checkpointId } = seededContext();
    expect(context.rewindTo(checkpointId, 'x'.repeat(MAX_REWIND_LESSON_CHARS + 1))).toEqual({
      rewound: false,
      refusal: 'lesson_too_long',
    });
    expect(context.rewindTo('ckpt-missing', 'lesson')).toEqual({
      rewound: false,
      refusal: 'unknown_checkpoint',
    });
  });

  it('invalidates checkpoints inside the discarded segment', () => {
    const { context, checkpointId } = seededContext();
    const innerCheckpoint = context.checkpoint();
    context.rewindTo(checkpointId, 'lesson');
    context.beginTurn();
    expect(context.rewindTo(innerCheckpoint, 'lesson')).toEqual({
      rewound: false,
      refusal: 'unknown_checkpoint',
    });
  });

  it('records rewinds observably: governance action, worker event, rewind count', async () => {
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    getDefaultWorkerEventStream().subscribe((event) =>
      seen.push({ type: event.type, payload: event.payload })
    );
    const { context, checkpointId } = seededContext();
    context.rewindTo(checkpointId, 'lesson');
    await new Promise((resolve) => setImmediate(resolve));

    expect(context.rewindCount).toBe(1);
    expect(recordGovernanceAction).toHaveBeenCalledWith(
      'context-rewind',
      'context_rewind',
      expect.stringContaining('MSN-REWIND-1'),
      false
    );
    expect(seen.map((event) => event.type)).toEqual(['context_rewind']);
    expect(seen[0].payload.total_rewinds).toBe(1);
  });
});

describe('buildContextRewindToolDefinition', () => {
  it('exposes checkpoint_id and lesson as required inputs', () => {
    const tool = buildContextRewindToolDefinition();
    expect(tool.name).toBe('context_rewind');
    expect(tool.inputSchema.required).toEqual(['checkpoint_id', 'lesson']);
  });
});
