import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TASK_MAX_STATE_BYTES,
  parseConversationTaskDecision,
  parseConversationTaskState,
  routeConversationTaskTurn,
  type ConversationTaskState,
  type ConversationTaskRecord,
} from './conversation-task-routing.js';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const task = (n: number, title = 'Request ' + n): ConversationTaskRecord => ({
  id: id(n),
  title,
  requestText: 'Create ' + title,
  createdAt: n,
  updates: [],
  state: 'recorded',
  execution: 'not_started',
});
const route = (state: ConversationTaskState, text: string, n = 99, locale?: 'en' | 'ja') =>
  routeConversationTaskTurn(state, text, id(n), 1000 + n, locale);
const two = (): ConversationTaskState => ({ tasks: [task(1, 'Aの報告書'), task(2, 'Bの報告書')] });

describe('bounded conversation task intake', () => {
  it.each([
    ['資料を作って', '資料'],
    ['Aの報告書を作って', 'Aの報告書'],
    ['Please prepare a report', 'a report'],
    ['Can you research Tokyo hotels?', 'Tokyo hotels?'],
  ])('records a new request without starting execution: %s', (text, title) => {
    const input: ConversationTaskState = { tasks: [] };
    const out = route(input, text, 1);
    expect(out.decision).toMatchObject({
      kind: 'new_request',
      taskIds: [id(1)],
      authority: 'none',
    });
    expect(out.state.tasks[0]).toMatchObject({
      title,
      requestText: text,
      execution: 'not_started',
      state: 'recorded',
    });
    expect(input.tasks).toEqual([]);
    expect(parseConversationTaskState(JSON.parse(JSON.stringify(out.state)))).toEqual(out.state);
    expect(parseConversationTaskDecision(JSON.parse(JSON.stringify(out.decision)))).toEqual(
      out.decision
    );
  });
  it('keeps the complete bounded source separately from the display title', () => {
    const text = 'Create ' + 'x'.repeat(8000);
    const out = route({ tasks: [] }, text);
    expect(out.state.tasks[0].title.length).toBe(512);
    expect(out.state.tasks[0].requestText).toBe(text);
  });
  it('creates separate durable requests instead of replacing the latest task', () => {
    const first = route({ tasks: [] }, 'Aの報告書を作って', 1);
    const second = route(first.state, 'Bの報告書を作って', 2);
    expect(second.state.tasks.map((entry) => entry.id)).toEqual([id(1), id(2)]);
    expect(first.state.tasks).toHaveLength(1);
  });
  it.each(['さっきの件どう？', 'Any updates?', '進捗は？'])(
    'asks about ambiguous existing requests: %s',
    (text) => {
      const out = route(two(), text);
      expect(out.decision.kind).toBe('clarification');
      expect(out.state.clarification).toEqual({
        kind: 'status',
        sourceTurnId: id(99),
        sourceText: text,
        candidateIds: [id(1), id(2)],
      });
    }
  );
  it.each(['1つ目', '一つ目', 'first', '1', 'Aの報告書', id(1)])(
    'recovers a persisted question by exact selection: %s',
    (selection) => {
      const ask = route(two(), 'さっきの件どう？');
      const restored = parseConversationTaskState(JSON.parse(JSON.stringify(ask.state)))!;
      const out = route(restored, selection, 100);
      expect(out.decision).toMatchObject({ kind: 'status', taskIds: [id(1)], authority: 'none' });
      expect(out.decision.reply).toContain('Aの報告書');
      expect(out.state.clarification).toBeUndefined();
    }
  );
  it.each(['Aの件どう？', 'Aの報告書の状況は？'])(
    'uses a unique explicit Japanese topic: %s',
    (text) => {
      expect(route(two(), text).decision).toMatchObject({ kind: 'status', taskIds: [id(1)] });
    }
  );
  it.each(['Bの件どう？', 'status of B', 'status of "' + id(2) + '"'])(
    'does not route an unknown named target to sole task A: %s',
    (text) => {
      const input = { tasks: [task(1, 'Aの報告書')] };
      const out = route(input, text);
      expect(out.decision.kind).toBe('clarification');
      expect(out.state).toEqual(input);
    }
  );
  it('answers an unambiguous deictic status honestly', () => {
    const out = route({ tasks: [task(1)] }, 'Any updates?', 99, 'en');
    expect(out.decision.reply).toContain('This conversation has not started execution');
    expect(out.decision.reply).toContain('Actual progress and results have not been verified');
    expect(out.state.tasks[0].state).toBe('recorded');
  });
  it('stores the original amendment when clarification is answered', () => {
    const ask = route(two(), '表を追加して', 3);
    const out = route(ask.state, '2つ目', 4);
    expect(out.decision).toMatchObject({ kind: 'followup', taskIds: [id(2)] });
    expect(out.state.tasks[0].updates).toEqual([]);
    expect(out.state.tasks[1].updates).toEqual(['表を追加して']);
  });
  it.each([
    'Make it shorter',
    'Add "confidential" to the title',
    'Change the title to "Q4 report"',
  ])('keeps amendment content distinct from task selectors: %s', (text) => {
    const out = route({ tasks: [task(1)] }, text);
    expect(out.decision.kind).toBe('followup');
    expect(out.state.tasks[0].updates).toEqual([text]);
  });
  it.each(['はい', 'yes', 'okay!'])(
    'does not use a vague confirmation to pick an ambiguous task: %s',
    (text) => {
      const ask = route(two(), '表を追加して', 3);
      const out = route(ask.state, text, 4);
      expect(out.decision.kind).toBe('clarification');
      expect(out.state).toEqual(ask.state);
    }
  );
  it.each(['Approve Request 1', 'Cancel Request 1', '承認します', '止めて'])(
    'classifies controls without conferring authority: %s',
    (text) => {
      const input = { tasks: [task(1)] };
      const out = route(input, text);
      expect(['approval', 'cancellation']).toContain(out.decision.kind);
      expect(out.decision.authority).toBe('none');
      expect(out.state).toEqual(input);
    }
  );
  it('resolves approval ambiguity without granting approval', () => {
    const ask = route(two(), '承認します', 3);
    const out = route(ask.state, '2', 4);
    expect(out.decision).toMatchObject({ kind: 'approval', authority: 'none', taskIds: [id(2)] });
    expect(out.state.tasks).toEqual(two().tasks);
  });
  it.each([
    'Create A and find B',
    'Please create A. Research B',
    'Create A and cancel B',
    '資料を作って、それと旅行を調べて',
    '進捗は？それから資料を作って',
    '1つ目。それと資料を作って',
  ])('refuses mixed requests without changing state: %s', (text) => {
    const input = two();
    const out = route(input, text);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
  it('does not consume a pending selection with a new clause', () => {
    const ask = route(two(), '表を追加して', 3);
    const out = route(ask.state, '1つ目。それと資料を作って', 4);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state.tasks).toEqual(ask.state.tasks);
    expect(out.state.clarification).toBeUndefined();
  });
  it.each([
    'hello there',
    'How are you?',
    'How is the weather?',
    'Do not cancel the report',
    'What does approve mean?',
  ])('preserves ordinary conversation: %s', (text) => {
    const out = route({ tasks: [task(1)] }, text);
    expect(out.decision).toEqual({
      kind: 'chat',
      taskIds: [],
      confidence: 'unknown',
      authority: 'none',
    });
  });
  it('invalidates an old selection after unrelated chat', () => {
    const ask = route(two(), '表を追加して', 3);
    const chat = route(ask.state, 'hello there', 4);
    expect(chat.state.clarification).toBeUndefined();
    const out = route(chat.state, '1', 5);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state.tasks.every((entry) => entry.updates.length === 0)).toBe(true);
  });
  it('keeps duplicate titles ambiguous', () => {
    const input = { tasks: [task(1, 'Report'), task(2, 'Report')] };
    const ask = route(input, 'status of Report', 3);
    const out = route(ask.state, 'Report', 4);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state.tasks).toEqual(input.tasks);
  });
  it('rejects new requests at capacity without evicting old ones', () => {
    const input = { tasks: Array.from({ length: 64 }, (_, n) => task(n + 1)) };
    const out = route(input, 'Create another report', 100);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
  it('round-trips max-count/max-title clarification replies', () => {
    const input = {
      tasks: Array.from({ length: 64 }, (_, n) => task(n + 1, String(n) + 'x'.repeat(510))),
    };
    const out = route(input, 'Any updates?', 100);
    expect(out.decision.reply!.length).toBeLessThan(32768);
    expect(parseConversationTaskState(JSON.parse(JSON.stringify(out.state)))).toEqual(out.state);
    expect(parseConversationTaskDecision(JSON.parse(JSON.stringify(out.decision)))).toEqual(
      out.decision
    );
  });
  it('refuses an amendment at its count limit without removing earlier instructions', () => {
    const input = {
      tasks: [{ ...task(1), updates: Array.from({ length: 64 }, () => 'existing') }],
    };
    const out = route(input, 'Add a chart');
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
  it('bounds escaped JSON bytes and rolls back an over-budget transition', () => {
    const update = '\u0000'.repeat(8192);
    const input = {
      tasks: [
        { ...task(1, 'first target'), updates: Array(64).fill(update) },
        { ...task(2, 'last target'), updates: Array(21).fill(update) },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(
      CONVERSATION_TASK_MAX_STATE_BYTES
    );
    expect(parseConversationTaskState(input)).toBeDefined();
    const out = route(input, 'Add ' + '\u0000'.repeat(8168) + ' to last target', 100);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
    const oversized = structuredClone(input);
    oversized.tasks[1].updates.push(update);
    expect(parseConversationTaskState(oversized)).toBeUndefined();
  });
});

describe('strict inert state and decision parsing', () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { tasks: 'x' },
    { tasks: [{}] },
    { tasks: [{ ...task(1), state: 'completed' }] },
    { tasks: [{ ...task(1), execution: 'executing' }] },
    { tasks: [{ ...task(1), requestText: undefined }] },
    { tasks: [{ ...task(1), createdAt: Infinity }] },
    { tasks: [{ ...task(1), title: 'x'.repeat(513) }] },
    { tasks: [task(1), task(1)] },
    {
      tasks: [task(1)],
      clarification: {
        kind: 'status',
        sourceTurnId: id(2),
        sourceText: 'status?',
        candidateIds: [id(3)],
      },
    },
    { tasks: [task(1)], approval: true },
  ])('fails closed on malformed persisted state %#', (input) => {
    expect(parseConversationTaskState(input)).toBeUndefined();
  });
  it('clones state and nested records', () => {
    const input = two();
    const parsed = parseConversationTaskState(input)!;
    parsed.tasks[0].updates.push('new');
    expect(input.tasks[0].updates).toEqual([]);
  });
  it('rejects actionable, inconsistent, oversized, or extra decision metadata', () => {
    const valid = route({ tasks: [task(1)] }, 'status').decision;
    expect(parseConversationTaskDecision(valid)).toEqual(valid);
    for (const change of [
      { authority: 'approved' },
      { approvalRequestId: 'x' },
      { kind: 'made_up' },
      { taskIds: [] },
      { taskIds: [id(1), id(1)] },
      { reply: 'x'.repeat(32769) },
      { confidence: 'unknown' },
    ])
      expect(parseConversationTaskDecision({ ...valid, ...change })).toBeUndefined();
  });
});

// Unknown target names must never inherit the only task.
describe('positive implicit-reference admission', () => {
  it.each(['Please tell me the status of B', 'Add a chart to B', 'status of ' + 'B'.repeat(200)])(
    'rejects an unbound named target: %s',
    (text) => {
      const input = { tasks: [task(1, 'A report')] };
      const out = route(input, text);
      expect(out.decision.kind).toBe('clarification');
      expect(out.state).toEqual(input);
    }
  );
});

describe('superseded task selection', () => {
  it('does not apply an old amendment after a different mixed request', () => {
    const ask = route(two(), '表を追加して', 3);
    const mixed = route(ask.state, 'Create X and find Y', 4);
    expect(mixed.state.clarification).toBeUndefined();
    const out = route(mixed.state, '1', 5);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state.tasks.every((t) => t.updates.length === 0)).toBe(true);
  });
  it('does not treat amendment content as its named destination', () => {
    const input = { tasks: [task(1, 'A report')] };
    const out = route(input, 'Add A report to B');
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
});

describe('bounded implicit amendment grammar', () => {
  it.each([
    'Change the title of B to Q4',
    'Update the title on B',
    'Make it shorter for B',
    'Please tell me the status of B with reference to A report',
  ])('never guesses a target for %s', (text) => {
    const input = { tasks: [task(1, 'A report')] };
    const out = route(input, text);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
  it('binds an explicitly named Japanese follow-up', () => {
    const out = route(two(), 'Aの報告書に表を追加して');
    expect(out.decision).toMatchObject({ kind: 'followup', taskIds: [id(1)] });
  });
});

describe('whole quoted target', () => {
  it.each([
    'status of \"A report\" and \"B report\"',
    'status of \"A report\" or \"B report\"',
    'Cancel \"A report\" and \"B report\"',
  ])('never discards additional targets: %s', (text) => {
    const input = { tasks: [task(1, 'A report'), task(2, 'B report')] };
    const out = route(input, text);
    expect(out.decision.kind).toBe('clarification');
    expect(out.state).toEqual(input);
  });
  it('matches exactly one whole quoted target', () => {
    expect(
      route({ tasks: [task(1, 'A report'), task(2, 'B report')] }, 'status of \"A report\"')
        .decision
    ).toMatchObject({ kind: 'status', taskIds: [id(1)] });
  });
});
