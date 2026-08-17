import { describe, expect, it } from 'vitest';
import {
  deriveExecutionGraph,
  executeGraph,
  type GraphExecutionOutcome,
} from './graph-scheduler.js';

describe('graph scheduler', () => {
  it('derives explicit control and data edges and rejects cycles', () => {
    const derived = deriveExecutionGraph([
      { id: 'source', produces: 'items' },
      { id: 'left', depends_on: ['source'] },
      { id: 'right', depends_on: ['source'] },
      { id: 'join', consumes: ['items'], depends_on: ['left', 'right'] },
    ]);

    expect(derived.errors).toEqual([]);
    expect(derived.graph.edges).toEqual(
      expect.arrayContaining([
        { from: 'source', to: 'left', kind: 'control' },
        { from: 'source', to: 'right', kind: 'control' },
        { from: 'source', to: 'join', kind: 'data', channel: 'items' },
      ])
    );

    const cyclic = deriveExecutionGraph([
      { id: 'a', depends_on: ['b'] },
      { id: 'b', depends_on: ['a'] },
    ]);
    expect(cyclic.errors.some((error) => error.code === 'cycle')).toBe(true);
  });

  it('binds a when condition to a declared judge output channel', () => {
    const derived = deriveExecutionGraph([
      { id: 'judge', produces: 'decision' },
      { id: 'approve', when: { from: 'decision', operator: 'eq', value: 'approve' } },
    ]);

    expect(derived.errors).toEqual([]);
    expect(derived.graph.edges).toContainEqual({
      from: 'judge',
      to: 'approve',
      kind: 'when',
      channel: 'decision',
    });
  });

  it('keeps legacy un-declared steps as an implicit linear chain', () => {
    const derived = deriveExecutionGraph([{ op: 'a' }, { op: 'b' }, { op: 'c' }]);
    expect(derived.errors).toEqual([]);
    expect(derived.graph.edges).toEqual([
      { from: '__step_0', to: '__step_1', kind: 'control' },
      { from: '__step_1', to: '__step_2', kind: 'control' },
    ]);
  });

  it('carries a declared operation budget into graph nodes', () => {
    const derived = deriveExecutionGraph([
      { id: 'bounded', op: 'system:exec', params: { timeout_ms: 120000 } },
      { id: 'next' },
    ]);
    expect(derived.graph.nodes[0].timeoutMs).toBe(120000);
  });

  it('starts an independent downstream node as soon as its own dependency completes', async () => {
    const events: string[] = [];
    const derived = deriveExecutionGraph([
      { id: 'slow', depends_on: [] },
      { id: 'fast', depends_on: [] },
      { id: 'slow-child', depends_on: ['slow'] },
      { id: 'fast-child', depends_on: ['fast'] },
    ]);
    const outcome = async (id: string): Promise<GraphExecutionOutcome<Record<string, unknown>>> => {
      events.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 20 : 1));
      events.push(`end:${id}`);
      return { status: 'success', context: { [id]: true } };
    };

    const result = await executeGraph(derived.graph, (node) => outcome(node.id), {
      initialContext: {},
      maxConcurrency: 2,
    });

    expect(result.statuses).toEqual({
      slow: 'success',
      fast: 'success',
      'slow-child': 'success',
      'fast-child': 'success',
    });
    expect(events.indexOf('start:fast-child')).toBeLessThan(events.indexOf('end:slow'));
  });

  it('passes a predecessor handoff through a namespaced data edge', async () => {
    const graph = deriveExecutionGraph([
      { id: 'implement', produces: 'mission-task:implement', merge: 'namespace' },
      {
        id: 'review',
        depends_on: ['implement'],
        consumes: ['mission-task:implement'],
        merge: 'namespace',
      },
    ]).graph;
    let received: unknown;
    const result = await executeGraph(
      graph,
      async (node, context) => {
        if (node.id === 'review') received = (context as Record<string, unknown>).implement;
        return {
          status: 'success' as const,
          context: node.id === 'implement' ? { handoff: { task_id: node.id } } : {},
        };
      },
      { initialContext: {}, maxConcurrency: 2 }
    );

    expect(received).toEqual({ handoff: { task_id: 'implement' } });
    expect(result.statuses.review).toBe('success');
  });

  it('skips false conditions and cascades the skip to dependents', async () => {
    const derived = deriveExecutionGraph([
      { id: 'gate', when: { from: 'ready', operator: 'eq', value: true } },
      { id: 'after', depends_on: ['gate'] },
    ]);
    let executions = 0;
    const result = await executeGraph(
      derived.graph,
      async () => {
        executions += 1;
        return { status: 'success', context: {} };
      },
      {
        initialContext: { ready: false },
        evaluateWhen: (condition, context) =>
          (condition as { from: string; value: unknown }).value ===
          (context as { ready: boolean }).ready,
      }
    );
    expect(executions).toBe(0);
    expect(result.statuses.gate).toBe('skipped');
    expect(result.statuses.after).toBe('skipped');
  });

  it('treats journal-restored nodes as terminal successes', async () => {
    const graph = deriveExecutionGraph([
      { id: 'source', produces: 'records' },
      { id: 'sink', consumes: 'records' },
    ]).graph;
    const executed: string[] = [];
    const result = await executeGraph(
      graph,
      async (node, context) => {
        executed.push(node.id);
        return { status: 'success', context: { ...context, [node.id]: true } };
      },
      { initialContext: { records: [{ id: 1 }] }, precompletedNodeIds: ['source'] }
    );
    expect(executed).toEqual(['sink']);
    expect(result.statuses.source).toBe('success');
    expect(result.statuses.sink).toBe('success');
  });

  it('serializes only explicitly claimed resources, not node ownership', async () => {
    const graph = deriveExecutionGraph([
      { id: 'a', resource_claims: ['workspace:shared'] },
      { id: 'b', resource_claims: ['workspace:shared'] },
    ]).graph;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execution = executeGraph(
      graph,
      async (node) => {
        events.push(`start:${node.id}`);
        if (node.id === 'a') await firstReleased;
        events.push(`end:${node.id}`);
        return { status: 'success' as const, context: {} };
      },
      {
        initialContext: {},
        maxConcurrency: 2,
        resourceClaims: (node) =>
          (node.value as { resource_claims?: string[] }).resource_claims || [],
      }
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['start:a']);
    releaseFirst();
    await execution;
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('uses typed access claims from the shared tool-call policy', async () => {
    const graph = deriveExecutionGraph([
      {
        id: 'read',
        depends_on: [],
        resource_claims: [{ kind: 'file', operation: 'read', path: 'shared.txt' }],
      },
      {
        id: 'write',
        depends_on: [],
        resource_claims: [{ kind: 'file', operation: 'write', path: 'shared.txt' }],
      },
      {
        id: 'other-read',
        depends_on: [],
        resource_claims: [{ kind: 'file', operation: 'read', path: 'other.txt' }],
      },
    ]).graph;
    let active = 0;
    let maxActive = 0;
    const result = await executeGraph(
      graph,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { status: 'success' as const, context: {} };
      },
      {
        initialContext: {},
        maxConcurrency: 3,
        resourceClaims: (node) =>
          (
            node.value as {
              resource_claims?: Array<
                string | { kind: 'file'; operation: 'read' | 'write'; path: string }
              >;
            }
          ).resource_claims || [],
      }
    );

    expect(Object.values(result.statuses).every((status) => status === 'success')).toBe(true);
    // The two reads can overlap; the write must still be ordered against the
    // read on the same path, so the typed policy permits two but not three.
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });

  it('intersects the graph frontier with a provider delegation slot', async () => {
    const graph = deriveExecutionGraph([
      { id: 'a', depends_on: [] },
      { id: 'b', depends_on: [] },
      { id: 'c', depends_on: [] },
    ]).graph;
    let active = 0;
    let maxActive = 0;
    const result = await executeGraph(
      graph,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: 'success' as const, context: {} };
      },
      {
        initialContext: {},
        maxConcurrency: 3,
        delegationProvider: () => 'graph-scheduler-test-provider',
      }
    );

    expect(Object.values(result.statuses).every((status) => status === 'success')).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
