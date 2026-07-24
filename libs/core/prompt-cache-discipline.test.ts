import { describe, expect, it } from 'vitest';
import {
  applyCacheBreakpointToLastMessage,
  applyCacheBreakpointToSystemBlocks,
  applyCacheBreakpointToTools,
  computeStablePrefixFingerprint,
  promoteDeferredToolDeclarations,
  PromptCachePrefixMutationError,
  renderDeferredToolAnnouncement,
  StablePrefixGuard,
} from './prompt-cache-discipline.js';
import {
  mergeAdjacentSameRoleMessages,
  renderInjectionsAsSystemReminders,
} from './dynamic-injection.js';

describe('computeStablePrefixFingerprint', () => {
  it('is independent of object key order (canonical JSON)', () => {
    const a = computeStablePrefixFingerprint({
      system: [{ type: 'text', text: 'hi' }],
      tools: [{ name: 't', description: 'd' }],
    });
    const b = computeStablePrefixFingerprint({
      tools: [{ description: 'd', name: 't' }],
      system: [{ text: 'hi', type: 'text' }],
    });
    expect(a).toBe(b);
  });

  it('ignores cache_control metadata — it is not part of the semantic prefix', () => {
    const withoutCache = computeStablePrefixFingerprint({
      system: [{ type: 'text', text: 'hi' }],
    });
    const withCache = computeStablePrefixFingerprint({
      system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    });
    expect(withCache).toBe(withoutCache);
  });

  it('differs when the semantic content actually changes', () => {
    const a = computeStablePrefixFingerprint({ system: [{ type: 'text', text: 'hi' }] });
    const b = computeStablePrefixFingerprint({ system: [{ type: 'text', text: 'bye' }] });
    expect(a).not.toBe(b);
  });
});

describe('StablePrefixGuard', () => {
  it('records the first call as the baseline without throwing', () => {
    const guard = new StablePrefixGuard();
    expect(guard.hasBaseline).toBe(false);
    expect(() => guard.assertStable({ system: [{ type: 'text', text: 'sys' }] })).not.toThrow();
    expect(guard.hasBaseline).toBe(true);
  });

  it('does not throw when the same prefix is asserted repeatedly', () => {
    const guard = new StablePrefixGuard();
    const snapshot = { system: [{ type: 'text', text: 'sys' }], tools: [{ name: 't' }] };
    guard.assertStable(snapshot);
    guard.assertStable({ system: [{ type: 'text', text: 'sys' }], tools: [{ name: 't' }] });
    expect(() => guard.assertStable(snapshot)).not.toThrow();
  });

  it('throws PromptCachePrefixMutationError when the prefix mutates mid-turn', () => {
    const guard = new StablePrefixGuard();
    guard.assertStable({ system: [{ type: 'text', text: 'sys' }], tools: [{ name: 't' }] });
    expect(() =>
      guard.assertStable({
        system: [{ type: 'text', text: 'sys' }],
        tools: [{ name: 't' }, { name: 'new-tool' }],
      })
    ).toThrow(PromptCachePrefixMutationError);
    expect(() =>
      guard.assertStable({
        system: [{ type: 'text', text: 'sys' }],
        tools: [{ name: 't' }, { name: 'new-tool' }],
      })
    ).toThrow(/PROMPT_CACHE_PREFIX_MUTATED/);
  });

  it('accepts a new baseline after reset() — the only legitimate boundary for a prefix change', () => {
    const guard = new StablePrefixGuard();
    guard.assertStable({ system: [{ type: 'text', text: 'sys-v1' }] });
    guard.reset();
    expect(guard.hasBaseline).toBe(false);
    expect(() =>
      guard.assertStable({ system: [{ type: 'text', text: 'sys-v2 (post-compaction)' }] })
    ).not.toThrow();
  });
});

describe('renderDeferredToolAnnouncement / promoteDeferredToolDeclarations', () => {
  it('returns null for an empty deferred list', () => {
    expect(renderDeferredToolAnnouncement([])).toBeNull();
  });

  it('renders a message-level announcement instead of a schema tool declaration', () => {
    const text = renderDeferredToolAnnouncement([
      { name: 'compute_stats', description: 'Computes summary statistics over a dataset.' },
    ]);
    expect(text).toContain('compute_stats');
    expect(text).toContain('Computes summary statistics over a dataset.');
    expect(text).toContain('next context boundary');
  });

  it('promotes deferred declarations after the stable ones, only when explicitly called', () => {
    const stable = [{ name: 'read_file' }];
    const deferred = [{ name: 'compute_stats' }];
    expect(promoteDeferredToolDeclarations(stable, deferred)).toEqual([
      { name: 'read_file' },
      { name: 'compute_stats' },
    ]);
    // Pure: neither input array is mutated.
    expect(stable).toEqual([{ name: 'read_file' }]);
    expect(deferred).toEqual([{ name: 'compute_stats' }]);
  });
});

describe('applyCacheBreakpointToSystemBlocks', () => {
  it('marks only the last block, leaving earlier blocks untouched', () => {
    const blocks = [
      { type: 'text' as const, text: 'first' },
      { type: 'text' as const, text: 'second' },
    ];
    const result = applyCacheBreakpointToSystemBlocks(blocks);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toEqual({ type: 'ephemeral' });
    // Pure: the input is untouched.
    expect(blocks[0]).not.toHaveProperty('cache_control');
    expect(blocks[1]).not.toHaveProperty('cache_control');
  });

  it('handles an empty array', () => {
    expect(applyCacheBreakpointToSystemBlocks([])).toEqual([]);
  });
});

describe('applyCacheBreakpointToTools', () => {
  it('marks only the last tool declaration', () => {
    const tools = [
      { name: 'read_file', description: 'Read a file.', input_schema: {} },
      { name: 'write_file', description: 'Write a file.', input_schema: {} },
    ];
    const result = applyCacheBreakpointToTools(tools);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(tools[0]).not.toHaveProperty('cache_control');
  });
});

describe('applyCacheBreakpointToLastMessage', () => {
  it('promotes a string content to a single cache-marked text block', () => {
    const result = applyCacheBreakpointToLastMessage([{ role: 'user', content: 'hello' }]);
    expect(result[0].content).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks only the last content block of an already-block-form message', () => {
    const result = applyCacheBreakpointToLastMessage([
      {
        role: 'user',
        content: [
          { type: 'image', source: {} },
          { type: 'text', text: 'prompt' },
        ],
      },
    ]);
    expect(
      (result[0].content as Array<{ cache_control?: unknown }>)[0].cache_control
    ).toBeUndefined();
    expect((result[0].content as Array<{ cache_control?: unknown }>)[1].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('only touches the last message, leaving earlier ones as shallow copies', () => {
    const messages = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'turn 1 reply' },
      { role: 'user', content: 'turn 2' },
    ];
    const result = applyCacheBreakpointToLastMessage(messages);
    expect(result[0].content).toBe('turn 1');
    expect(result[1].content).toBe('turn 1 reply');
    expect(result[2].content).toEqual([
      { type: 'text', text: 'turn 2', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('handles an empty array', () => {
    expect(applyCacheBreakpointToLastMessage([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// KD-08 acceptance criterion 1: golden 3-turn fixture.
// ---------------------------------------------------------------------------

describe('KD-08 golden: stable-prefix byte sequence across a 3-turn fixture', () => {
  it('keeps system + tools byte-identical across turns that add an injection and a dynamic tool', () => {
    const systemBlocks = applyCacheBreakpointToSystemBlocks([
      { type: 'text' as const, text: 'You are Kyberion, a governed reasoning backend.' },
    ]);
    const tools = applyCacheBreakpointToTools([
      {
        name: 'read_file',
        description: 'Read a file from the governed workspace.',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    const prefixSnapshot = () => ({ system: systemBlocks, tools });
    const prefixByteSequence = () => JSON.stringify(prefixSnapshot());

    const guard = new StablePrefixGuard();

    // Turn 1: the opening user message.
    let messages: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'Please summarize the quarterly report.' },
    ];
    guard.assertStable(prefixSnapshot());
    const turn1Bytes = prefixByteSequence();

    // Turn 2: a KC-08 dynamic-injection reminder lands as its own message —
    // the injection provider contract never touches system/tools.
    const injectionText = renderInjectionsAsSystemReminders([
      { providerId: 'working-principles', text: 'Follow the working principles brief.' },
    ]);
    messages = mergeAdjacentSameRoleMessages([
      ...messages,
      { role: 'user', content: injectionText },
    ]);
    guard.assertStable(prefixSnapshot());
    const turn2Bytes = prefixByteSequence();

    // Turn 3: a new tool becomes available mid-conversation. The unsafe path
    // would splice it into the stable `tools` array; the safe (deferred)
    // path announces it in a message instead and leaves the array alone.
    const announcement = renderDeferredToolAnnouncement([
      { name: 'compute_stats', description: 'Computes summary statistics over a dataset.' },
    ]);
    expect(announcement).not.toBeNull();
    messages = mergeAdjacentSameRoleMessages([
      ...messages,
      { role: 'user', content: announcement! },
    ]);
    guard.assertStable(prefixSnapshot());
    const turn3Bytes = prefixByteSequence();

    // The golden assertion: the prefix byte sequence is unchanged turn over turn.
    expect(turn2Bytes).toBe(turn1Bytes);
    expect(turn3Bytes).toBe(turn1Bytes);

    // Only the message history grew; the tools array still has exactly the
    // one schema-declared tool from turn 1 (compute_stats was never
    // inserted). All 3 turns were user-role, so KC-08's
    // mergeAdjacentSameRoleMessages folds them into a single message —
    // exactly the "grows via messages, not via the prefix" behavior this
    // test is checking — and all 3 turns' text is still present in it.
    expect(tools).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('Please summarize the quarterly report.');
    expect(messages[0].content).toContain('Follow the working principles brief.');
    expect(messages[0].content).toContain('compute_stats');
  });

  it('fails fast when a caller naively splices a tool into the stable array mid-turn', () => {
    const systemBlocks = applyCacheBreakpointToSystemBlocks([
      { type: 'text' as const, text: 'sys' },
    ]);
    const tools = applyCacheBreakpointToTools([
      { name: 'read_file', description: 'x', input_schema: {} },
    ]);
    const guard = new StablePrefixGuard();
    guard.assertStable({ system: systemBlocks, tools });

    const naivelyMutatedTools = [
      ...tools,
      { name: 'compute_stats', description: 'y', input_schema: {} },
    ];
    expect(() => guard.assertStable({ system: systemBlocks, tools: naivelyMutatedTools })).toThrow(
      PromptCachePrefixMutationError
    );
  });
});
