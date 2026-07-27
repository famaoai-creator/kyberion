/**
 * Small, deterministic frontier scheduler shared by pipeline and mission
 * execution. The scheduler owns graph state only; node handlers own I/O,
 * retries, and side effects.
 */

export type GraphEdgeKind = 'control' | 'data' | 'when';
export type GraphMergePolicy = 'collect' | 'namespace' | 'last';

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  channel?: string;
}

export interface GraphNode<T> {
  id: string;
  index: number;
  value: T;
  dependencies: string[];
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
  when?: unknown;
  merge: GraphMergePolicy;
}

export interface ExecutionGraph<T> {
  nodes: GraphNode<T>[];
  edges: GraphEdge[];
}

export interface GraphValidationError {
  code:
    | 'duplicate-id'
    | 'missing-dependency'
    | 'missing-channel'
    | 'cycle'
    | 'id-required-for-dependency';
  message: string;
  nodeId?: string;
}

export interface GraphStepLike {
  id?: string;
  depends_on?: string[];
  produces?: string | { channel: string };
  consumes?: string | string[];
  when?: unknown;
  merge?: GraphMergePolicy;
  resource_claims?: string[];
  params?: Record<string, unknown>;
}

export interface GraphBuildResult<T> {
  graph: ExecutionGraph<T>;
  errors: GraphValidationError[];
}

function channels(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function producedChannel(step: GraphStepLike): string | undefined {
  if (step.produces) {
    return typeof step.produces === 'string' ? step.produces : step.produces.channel;
  }
  const exportAs = step.params?.export_as;
  return typeof exportAs === 'string' && exportAs.length > 0 ? exportAs : undefined;
}

function addEdge(edges: GraphEdge[], edge: GraphEdge): void {
  if (edge.from === edge.to) {
    edges.push(edge);
    return;
  }
  if (
    !edges.some(
      (existing) =>
        existing.from === edge.from &&
        existing.to === edge.to &&
        existing.kind === edge.kind &&
        existing.channel === edge.channel
    )
  ) {
    edges.push(edge);
  }
}

/** Derive the effective control/data graph without touching the filesystem. */
export function deriveExecutionGraph<T>(
  steps: T[],
  initialChannels: Iterable<string> = []
): GraphBuildResult<T> {
  const graphSteps = steps as unknown as GraphStepLike[];
  const errors: GraphValidationError[] = [];
  const ids = graphSteps.map((step, index) => step.id || `__step_${index}`);
  const seen = new Set<string>();
  ids.forEach((id) => {
    if (seen.has(id))
      errors.push({
        code: 'duplicate-id',
        nodeId: id,
        message: `Duplicate graph node id "${id}".`,
      });
    seen.add(id);
  });

  const edges: GraphEdge[] = [];
  const hasExplicitGraph = graphSteps.some(
    (step) =>
      Array.isArray(step.depends_on) || step.consumes !== undefined || step.when !== undefined
  );
  const producers = new Map<string, string[]>();
  const initial = new Set(initialChannels);
  const nestedProduced = new Set<string>();
  const collectNestedProduced = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const step = raw as GraphStepLike & { params?: Record<string, unknown> };
      const channel = producedChannel(step);
      if (channel) nestedProduced.add(channel);
      for (const key of ['pipeline', 'do', 'then', 'else', 'calls', 'steps']) {
        collectNestedProduced(step.params?.[key]);
      }
    }
  };
  for (const step of graphSteps) {
    const params = (step as GraphStepLike & { params?: Record<string, unknown> }).params;
    for (const key of ['pipeline', 'do', 'then', 'else', 'calls', 'steps']) {
      collectNestedProduced(params?.[key]);
    }
  }
  graphSteps.forEach((step, index) => {
    const channel = producedChannel(step);
    if (channel) producers.set(channel, [...(producers.get(channel) || []), ids[index]]);
  });

  graphSteps.forEach((step, index) => {
    const id = ids[index];
    if (step.depends_on) {
      if (!step.id) {
        errors.push({
          code: 'id-required-for-dependency',
          nodeId: id,
          message: `Step ${index} declares depends_on and must declare an id.`,
        });
      }
      for (const dependency of step.depends_on) {
        if (!seen.has(dependency)) {
          errors.push({
            code: 'missing-dependency',
            nodeId: id,
            message: `Graph node "${id}" depends on unknown node "${dependency}".`,
          });
        } else {
          addEdge(edges, { from: dependency, to: id, kind: 'control' });
        }
      }
    }
    for (const channel of channels(step.consumes)) {
      const channelProducers = producers.get(channel) || [];
      if (channelProducers.length === 0 && !nestedProduced.has(channel) && !initial.has(channel)) {
        errors.push({
          code: 'missing-channel',
          nodeId: id,
          message: `Graph node "${id}" consumes channel "${channel}" but no producer exists.`,
        });
      }
      for (const producer of channelProducers) {
        addEdge(edges, { from: producer, to: id, kind: 'data', channel });
      }
    }
    if (step.when !== undefined) {
      const dependency = step.depends_on?.[0] || (index > 0 ? ids[index - 1] : undefined);
      if (dependency && seen.has(dependency))
        addEdge(edges, { from: dependency, to: id, kind: 'when' });
    }
  });

  // A completely legacy pipeline remains a strict linear chain. In a mixed
  // graph, an otherwise isolated undeclared node retains the same safe
  // implicit dependency on its predecessor.
  for (let index = 1; index < ids.length; index += 1) {
    const hasIncoming = edges.some((edge) => edge.to === ids[index]);
    const step = graphSteps[index];
    if (
      !hasIncoming &&
      (!hasExplicitGraph || (step.depends_on === undefined && step.consumes === undefined))
    ) {
      addEdge(edges, { from: ids[index - 1], to: ids[index], kind: 'control' });
    }
  }

  const nodes: GraphNode<T>[] = ids.map((id, index) => ({
    id,
    index,
    value: steps[index],
    dependencies: edges.filter((edge) => edge.to === id).map((edge) => edge.from),
    incoming: edges.filter((edge) => edge.to === id),
    outgoing: edges.filter((edge) => edge.from === id),
    when: graphSteps[index].when,
    merge: graphSteps[index].merge || 'last',
  }));

  const remaining = new Map(nodes.map((node) => [node.id, node.dependencies.length]));
  const queue = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const edge of edges.filter((candidate) => candidate.from === current)) {
      const next = (remaining.get(edge.to) || 0) - 1;
      remaining.set(edge.to, next);
      if (next === 0) queue.push(edge.to);
    }
  }
  if (visited !== nodes.length)
    errors.push({ code: 'cycle', message: 'Pipeline graph contains a cycle.' });

  return { graph: { nodes, edges }, errors };
}

export type GraphNodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface GraphExecutionOutcome<C> {
  status: Exclude<GraphNodeStatus, 'pending' | 'running'>;
  context?: C;
  error?: string;
}

export interface GraphExecutionOptions<C> {
  maxConcurrency?: number;
  initialContext: C;
  /** Nodes restored from a durable run journal. They are terminal successes. */
  precompletedNodeIds?: Iterable<string>;
  /** Nodes known to be blocked before this scheduler invocation. */
  preskippedNodeIds?: Iterable<string>;
  evaluateWhen?: (condition: unknown, context: C) => boolean;
  resourceClaims?: (node: GraphNode<unknown>, context: C) => string[];
  mergeContext?: (
    current: C,
    next: C,
    node: GraphNode<unknown>,
    outcome: GraphExecutionOutcome<C>
  ) => C;
  onNodeSettled?: (
    node: GraphNode<unknown>,
    outcome: GraphExecutionOutcome<C>,
    durationMs: number
  ) => void;
}

export interface GraphExecutionResult<C> {
  context: C;
  statuses: Record<string, GraphNodeStatus>;
  outcomes: Record<string, GraphExecutionOutcome<C>>;
}

function defaultMerge<C>(current: C, next: C): C {
  if (current && next && typeof current === 'object' && typeof next === 'object') {
    return { ...(current as Record<string, unknown>), ...(next as Record<string, unknown>) } as C;
  }
  return next;
}

/** Completion-driven frontier execution. No provider or filesystem knowledge. */
export async function executeGraph<T, C>(
  graph: ExecutionGraph<T>,
  execute: (node: GraphNode<T>, context: C) => Promise<GraphExecutionOutcome<C>>,
  options: GraphExecutionOptions<C>
): Promise<GraphExecutionResult<C>> {
  const limit = Math.max(1, Math.floor(options.maxConcurrency || 1));
  let context = options.initialContext;
  const statuses: Record<string, GraphNodeStatus> = Object.fromEntries(
    graph.nodes.map((node) => [node.id, 'pending'])
  );
  const outcomes: Record<string, GraphExecutionOutcome<C>> = {};
  const active = new Map<
    string,
    { promise: Promise<GraphExecutionOutcome<C>>; claims: string[] }
  >();
  const claimsInUse = new Set<string>();
  const startedAt = new Map<string, number>();

  for (const id of options.precompletedNodeIds || []) {
    if (statuses[id] === 'pending') {
      statuses[id] = 'success';
      outcomes[id] = { status: 'success', context };
      const restoredNode = graph.nodes.find((node) => node.id === id);
      if (restoredNode) {
        options.onNodeSettled?.(restoredNode as GraphNode<unknown>, outcomes[id], 0);
      }
    }
  }
  for (const id of options.preskippedNodeIds || []) {
    if (statuses[id] === 'pending') {
      statuses[id] = 'skipped';
      outcomes[id] = { status: 'skipped', error: 'pre-existing blocked node' };
      const blockedNode = graph.nodes.find((node) => node.id === id);
      if (blockedNode) options.onNodeSettled?.(blockedNode as GraphNode<unknown>, outcomes[id], 0);
    }
  }

  const terminal = (id: string) => ['success', 'failed', 'skipped'].includes(statuses[id]);
  const claimsConflict = (left: string, right: string): boolean =>
    left === right || left === 'resource:all' || right === 'resource:all';
  const canClaim = (claims: string[]) =>
    claims.every((claim) => [...claimsInUse].every((inUse) => !claimsConflict(claim, inUse)));

  while (Object.values(statuses).some((status) => status === 'pending' || status === 'running')) {
    let progressed = false;
    for (const node of graph.nodes) {
      if (statuses[node.id] !== 'pending' || active.size >= limit) continue;
      if (!node.dependencies.every(terminal)) continue;
      const blocked = node.dependencies.some((dependency) =>
        ['failed', 'skipped'].includes(statuses[dependency])
      );
      if (blocked) {
        statuses[node.id] = 'skipped';
        outcomes[node.id] = {
          status: 'skipped',
          error: 'blocked by a failed or skipped dependency',
        };
        options.onNodeSettled?.(node as GraphNode<unknown>, outcomes[node.id], 0);
        progressed = true;
        continue;
      }
      if (
        node.when !== undefined &&
        options.evaluateWhen &&
        !options.evaluateWhen(node.when, context)
      ) {
        statuses[node.id] = 'skipped';
        outcomes[node.id] = { status: 'skipped', error: 'when condition evaluated to false' };
        options.onNodeSettled?.(node as GraphNode<unknown>, outcomes[node.id], 0);
        progressed = true;
        continue;
      }
      const claims = options.resourceClaims
        ? options.resourceClaims(node as GraphNode<unknown>, context)
        : [];
      if (!canClaim(claims)) continue;
      statuses[node.id] = 'running';
      startedAt.set(node.id, Date.now());
      claims.forEach((claim) => claimsInUse.add(claim));
      const nodeContext = context;
      const promise = execute(node, nodeContext).catch((error: unknown) => ({
        status: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      active.set(node.id, { promise, claims });
      progressed = true;
    }

    if (active.size === 0) {
      if (!progressed)
        throw new Error('Graph scheduler deadlock: no ready node and no active node.');
      continue;
    }

    const completed = await Promise.race(
      [...active.entries()].map(async ([id, slot]) => ({ id, outcome: await slot.promise }))
    );
    const slot = active.get(completed.id)!;
    active.delete(completed.id);
    slot.claims.forEach((claim) => claimsInUse.delete(claim));
    statuses[completed.id] = completed.outcome.status;
    outcomes[completed.id] = completed.outcome;
    options.onNodeSettled?.(
      graph.nodes.find((candidate) => candidate.id === completed.id)! as GraphNode<unknown>,
      completed.outcome,
      Date.now() - (startedAt.get(completed.id) || Date.now())
    );
    if (completed.outcome.context !== undefined) {
      const node = graph.nodes.find((candidate) => candidate.id === completed.id)!;
      if (options.mergeContext) {
        context = options.mergeContext(
          context,
          completed.outcome.context,
          node as GraphNode<unknown>,
          completed.outcome
        );
      } else if (node.merge === 'namespace') {
        context = {
          ...(context as Record<string, unknown>),
          [node.id]: completed.outcome.context,
        } as C;
      } else if (node.merge === 'collect') {
        const current = context as Record<string, unknown>;
        const collected = Array.isArray(current.__graph_collect) ? current.__graph_collect : [];
        context = {
          ...current,
          ...((completed.outcome.context as Record<string, unknown>) || {}),
          __graph_collect: [...collected, { node_id: node.id, context: completed.outcome.context }],
        } as C;
      } else {
        context = defaultMerge(context, completed.outcome.context);
      }
    }
  }

  return { context, statuses, outcomes };
}
