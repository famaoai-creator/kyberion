/** Explicit-state safety checking. Completeness is relative to the supplied finite model. */
export interface ModelStep<State> {
  action: string;
  state: State;
}

export interface SafetyModel<State> {
  initial: readonly State[];
  /** Keys must encode every fact relevant to successors and invariants. */
  key: (state: State) => string;
  next: (state: State) => readonly ModelStep<State>[];
  invariants: Readonly<Record<string, (state: State) => boolean>>;
}

export type SafetyCheckResult<State> = {
  status: 'verified' | 'violated' | 'inconclusive';
  visited: number;
  transitions: number;
  invariant?: string;
  /** Shortest counterexample, including the initial state. */
  trace?: ModelStep<State>[];
};

/** Breadth-first exploration; hitting the budget must never report verification. */
export function checkFiniteStateSafety<State>(
  model: SafetyModel<State>,
  maxStates = 10_000
): SafetyCheckResult<State> {
  if (!Number.isSafeInteger(maxStates) || maxStates < 1) {
    throw new RangeError('maxStates must be a positive safe integer');
  }
  const nodes: { step: ModelStep<State>; parent: number | undefined }[] = [];
  const seen = new Set<string>();
  let transitions = 0;
  const add = (step: ModelStep<State>, parent?: number): boolean => {
    const key = model.key(step.state);
    if (seen.has(key)) return true;
    if (seen.size >= maxStates) return false;
    seen.add(key);
    nodes.push({ step, parent });
    return true;
  };
  for (const state of model.initial) {
    if (!add({ action: 'initial', state })) {
      return { status: 'inconclusive', visited: seen.size, transitions };
    }
  }
  if (!nodes.length) throw new Error('A safety model needs at least one initial state');
  for (let cursor = 0; cursor < nodes.length; cursor++) {
    const state = nodes[cursor]!.step.state;
    for (const [name, invariant] of Object.entries(model.invariants)) {
      if (invariant(state)) continue;
      const trace: ModelStep<State>[] = [];
      let index: number | undefined = cursor;
      while (index !== undefined) {
        const node: (typeof nodes)[number] = nodes[index]!;
        trace.push(node.step);
        index = node.parent;
      }
      return {
        status: 'violated',
        visited: seen.size,
        transitions,
        invariant: name,
        trace: trace.reverse(),
      };
    }
    for (const step of model.next(state)) {
      transitions++;
      if (!add(step, cursor)) {
        return { status: 'inconclusive', visited: seen.size, transitions };
      }
    }
  }
  return { status: 'verified', visited: seen.size, transitions };
}
