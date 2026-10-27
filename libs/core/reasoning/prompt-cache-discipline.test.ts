import { describe, expect, it } from 'vitest';
import {
  applyCacheBreakpointToLastMessage,
  applyCacheBreakpointToSystemBlocks,
  applyCacheBreakpointToTools,
  computeStablePrefixFingerprint,
  DEFAULT_DEFERRED_TOOL_ANNOUNCEMENT_MAX_BYTES,
  appendDeferredToolAnnouncement,
  planDeferredToolLoading,
  promoteDeferredToolDeclarations,
  PromptCachePrefixMutationError,
  renderDeferredToolAnnouncement,
  StablePrefixGuard,
} from './prompt-cache-discipline.js';
import {
  mergeAdjacentSameRoleMessages,
  renderInjectionsAsSystemReminders,
} from '../dynamic-injection.js';

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

  it('drops descriptions before names when a catalog exceeds the complete announcement budget', () => {
    const tools = Array.from({ length: 4 }, (_, index) => ({
      name: `github_search_${index}`,
      description: 'A lengthy description of GitHub issue searching. '.repeat(30),
    }));
    const text = renderDeferredToolAnnouncement(tools, { maxBytes: 400 })!;
    for (const tool of tools) expect(text).toContain(tool.name);
    expect(text).not.toContain('lengthy description');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(400);
  });

  it('summarizes thousands of tools by namespace without truncating their definitions', () => {
    const tools = Array.from({ length: 5_000 }, (_, index) => ({
      name: `mcp__${index % 2 ? 'github' : 'slack'}__operation_${index}`,
      description: 'Search or update a remote object.',
    }));
    const plan = planDeferredToolLoading([], { deferredTools: tools });
    expect(plan.deferred).toEqual(tools);
    expect(plan.active).toEqual([]);
    expect(plan.announcement).toContain('5000 deferred tools in 2 namespaces');
    expect(plan.announcement).toContain('mcp:github: 2500 tools');
    expect(plan.announcement).toContain('mcp:slack: 2500 tools');
    expect(plan.announcement).toContain('Search the governed catalog');
    expect(Buffer.byteLength(plan.announcement!, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_DEFERRED_TOOL_ANNOUNCEMENT_MAX_BYTES
    );
    expect(plan.announcement).toBe(renderDeferredToolAnnouncement(tools));
  });

  it('counts UTF-8 bytes and bounds an overview even with many long Unicode namespaces', () => {
    const tools = Array.from({ length: 100 }, (_, index) => ({
      name: `mcp__接続先${index}😀${'界'.repeat(100)}__操作`,
      description: '日本語の説明😀'.repeat(100),
    }));
    const text = renderDeferredToolAnnouncement(tools, { maxBytes: 256 })!;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(256);
    expect(text).toContain('100 deferred tools');
    expect(text).toContain('100 other namespaces omitted');
    expect(text).not.toContain('\uFFFD');
  });

  it('filters role-denied tools before counting and grouping a bounded catalog', () => {
    const visible = Array.from({ length: 50 }, (_, index) => ({
      name: `mcp__public__read_${index}`,
      description: 'Read governed public data.',
      allowed_roles: ['agent'],
    }));
    const plan = planDeferredToolLoading(
      [
        ...visible,
        {
          name: 'mcp__private__deploy',
          description: 'Secret deployment.',
          allowed_roles: ['admin'],
        },
      ],
      {
        role: 'agent',
        deferredToolNames: visible.map((tool) => tool.name),
        announcement: { maxBytes: 256 },
      }
    );
    expect(plan.announcement).toContain('50 deferred tools in 1 namespaces');
    expect(plan.announcement).not.toContain('private');
    expect(plan.announcement).not.toContain('Secret');
    expect(plan.deferred).toEqual(visible);
  });

  it('rejects invalid budgets rather than silently producing an unbounded catalog', () => {
    for (const maxBytes of [NaN, Infinity, -1, 0, 255, 300.5]) {
      expect(() =>
        renderDeferredToolAnnouncement([{ name: 'read_file', description: 'Read.' }], { maxBytes })
      ).toThrow(/DEFERRED_TOOL_BUDGET_INVALID/);
    }
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

  it('plans a role-scoped active set and keeps deferred tools out of the schema prefix', () => {
    const plan = planDeferredToolLoading(
      [
        { name: 'read_file', description: 'Read a file.' },
        { name: 'deploy', description: 'Deploy a release.', allowed_roles: ['operator'] },
        { name: 'search', description: 'Search knowledge.', allowed_roles: ['operator', 'agent'] },
      ],
      { role: 'agent', deferredToolNames: ['search'] }
    );
    expect(plan.active.map((tool) => tool.name)).toEqual(['read_file']);
    expect(plan.deferred.map((tool) => tool.name)).toEqual(['search']);
    expect(plan.announcement).toContain('search');
    expect(appendDeferredToolAnnouncement('base prompt', plan.announcement)).toContain(
      'base prompt\n\n'
    );
    expect(plan.active).not.toContainEqual(expect.objectContaining({ name: 'search' }));
  });

  it('fails closed for unknown or role-denied deferred tools', () => {
    const tools = [{ name: 'deploy', description: 'Deploy.', allowed_roles: ['operator'] }];
    expect(() => planDeferredToolLoading(tools, { deferredToolNames: ['missing'] })).toThrow(
      /DEFERRED_TOOL_UNKNOWN/
    );
    expect(() =>
      planDeferredToolLoading(tools, { role: 'agent', deferredToolNames: ['deploy'] })
    ).toThrow(/DEFERRED_TOOL_ROLE_DENIED/);
  });

  it('validates explicit deferred definitions with the same role boundary', () => {
    const plan = planDeferredToolLoading([{ name: 'read_file', description: 'Read a file.' }], {
      role: 'agent',
      deferredTools: [
        {
          name: 'search',
          description: 'Search knowledge.',
          allowed_roles: ['agent'],
        },
      ],
    });
    expect(plan.active.map((tool) => tool.name)).toEqual(['read_file']);
    expect(plan.deferred.map((tool) => tool.name)).toEqual(['search']);
    expect(() =>
      planDeferredToolLoading([{ name: 'read_file', description: 'Read a file.' }], {
        role: 'agent',
        deferredTools: [
          {
            name: 'deploy',
            description: 'Deploy a release.',
            allowed_roles: ['operator'],
          },
        ],
      })
    ).toThrow(/DEFERRED_TOOL_ROLE_DENIED/);
  });

  it('rejects duplicate catalog names before producing a model-visible plan', () => {
    expect(() =>
      planDeferredToolLoading([
        { name: 'read_file', description: 'first' },
        { name: 'read_file', description: 'second' },
      ])
    ).toThrow(/DEFERRED_TOOL_DUPLICATE/);
  });

  it('uses canonical names when selecting deferred catalog entries', () => {
    const plan = planDeferredToolLoading([{ name: ' search ', description: 'Search knowledge.' }], {
      deferredToolNames: ['search'],
    });
    expect(plan.active).toEqual([]);
    expect(plan.deferred.map((tool) => tool.name)).toEqual([' search ']);
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
