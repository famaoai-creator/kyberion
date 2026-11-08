import { describe, expect, it } from 'vitest';
import { checkFiniteStateSafety, type SafetyModel } from '../testing/finite-state-checker.js';
import { createMemoryLeaseBackend } from './memory-lease-backend.js';

type Actor = 0 | 1;
type Phase = 'idle' | 'queued' | 'running' | 'done';
type Action = { kind: 'enqueue' | 'resolve' | 'reject'; actor: Actor } | { kind: 'sync' };
interface State {
  phases: Phase[];
  active: Actor | null;
  queue: Actor[];
  overlap: boolean;
}
const initial = (): State => ({
  phases: ['idle', 'idle'],
  active: null,
  queue: [],
  overlap: false,
});
const label = (action: Action) =>
  action.kind === 'sync' ? 'sync' : `${action.kind}:${action.actor}`;

// Independent specification of two one-shot callers. Enqueue/settle actions
// include the microtask handoff; a synchronous probe is atomic.
function choices(state: State): Action[] {
  const actions: Action[] = [0, 1].flatMap((actor) =>
    state.phases[actor] === 'idle' ? [{ kind: 'enqueue' as const, actor: actor as Actor }] : []
  );
  if (state.active !== null) {
    actions.push({ kind: 'resolve', actor: state.active }, { kind: 'reject', actor: state.active });
  }
  return [...actions, { kind: 'sync' }];
}
function advance(state: State, action: Action, broken = false): State {
  const next = { ...state, phases: [...state.phases], queue: [...state.queue] };
  if (action.kind === 'sync') {
    next.overlap ||= broken && state.active !== null;
  } else if (action.kind === 'enqueue') {
    next.phases[action.actor] = state.active === null ? 'running' : 'queued';
    if (state.active === null) next.active = action.actor;
    else next.queue.push(action.actor);
  } else {
    next.phases[action.actor] = 'done';
    next.active = next.queue.shift() ?? null;
    if (next.active !== null) next.phases[next.active] = 'running';
  }
  return next;
}
function model(broken = false): SafetyModel<State> {
  return {
    initial: [initial()],
    key: JSON.stringify,
    next: (state) =>
      choices(state).map((action) => ({
        action: label(action),
        state: advance(state, action, broken),
      })),
    invariants: {
      'sync and async callbacks never overlap': (state) => !state.overlap,
      'one running async callback': (state) =>
        state.phases.filter((phase) => phase === 'running').length <= 1,
      'active identity matches phase': (state) =>
        state.phases.every((phase, actor) => (phase === 'running') === (actor === state.active)),
      'queue matches waiting callers': (state) =>
        state.queue.length === state.phases.filter((phase) => phase === 'queued').length &&
        new Set(state.queue).size === state.queue.length &&
        state.queue.every((actor) => state.phases[actor] === 'queued'),
    },
  };
}
function schedules(depth: number): Action[][] {
  const all: Action[][] = [[]];
  let frontier = [{ state: initial(), actions: [] as Action[] }];
  for (let level = 0; level < depth; level++) {
    frontier = frontier.flatMap(({ state, actions }) =>
      choices(state).map((action) => ({
        state: advance(state, action),
        actions: [...actions, action],
      }))
    );
    all.push(...frontier.map(({ actions }) => actions));
  }
  return all;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function replay(actions: Action[]): Promise<void> {
  const backend = createMemoryLeaseBackend();
  const active = new Set<Actor>();
  const jobs = new Map<
    Actor,
    {
      gate: ReturnType<typeof deferred>;
      entered: ReturnType<typeof deferred>;
      settled: Promise<unknown>;
    }
  >();
  let state = initial();
  const errors = [new Error('caller 0 failed'), new Error('caller 1 failed')];
  try {
    for (const action of actions) {
      const before = state;
      state = advance(state, action);
      if (action.kind === 'enqueue') {
        const gate = deferred();
        const entered = deferred();
        const run = backend.withLock('resource', async () => {
          active.add(action.actor);
          entered.resolve();
          try {
            await gate.promise;
          } finally {
            active.delete(action.actor);
          }
        });
        const settled = run.then(
          () => undefined,
          (error: unknown) => error
        );
        jobs.set(action.actor, { gate, entered, settled });
        if (before.active === null) await entered.promise;
      } else if (action.kind === 'sync') {
        let admitted = false;
        let overlapped = false;
        let refusal: unknown;
        try {
          backend.withLockSync('resource', () => {
            admitted = true;
            overlapped = active.size !== 0;
          });
        } catch (error) {
          refusal = error;
        }
        expect(admitted).toBe(before.active === null && before.queue.length === 0);
        expect(overlapped).toBe(false);
        if (!admitted) expect(String(refusal)).toContain('[LEASE_BACKEND]');
      } else {
        const job = jobs.get(action.actor)!;
        if (action.kind === 'resolve') job.gate.resolve();
        else job.gate.reject(errors[action.actor]!);
        expect(await job.settled).toBe(
          action.kind === 'resolve' ? undefined : errors[action.actor]
        );
        if (state.active !== null) await jobs.get(state.active)!.entered.promise;
      }
      expect([...active], actions.map(label).join(' -> ')).toEqual(
        state.active === null ? [] : [state.active]
      );
    }
  } finally {
    // Finish every launched callback even if a comparison fails. No unresolved
    // test promises or timers may escape into another schedule.
    for (const job of jobs.values()) job.gate.resolve();
    await Promise.all([...jobs.values()].map((job) => job.settled));
  }
}

describe('lease backend finite-state exclusion model', () => {
  it('exhausts the graph including success, rejection and sync probes', () => {
    expect(checkFiniteStateSafety(model())).toEqual({
      status: 'verified',
      visited: 10,
      transitions: 28,
    });
  });
  it('finds a shortest counterexample when sync entry bypasses async ownership', () => {
    const result = checkFiniteStateSafety(model(true));
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('sync and async callbacks never overlap');
    expect(result.trace?.map((step) => step.action)).toEqual(['initial', 'enqueue:0', 'sync']);
  });
  const traces = schedules(5);
  it(`matches production for ${traces.length} valid schedules through five actions`, async () => {
    for (const actions of traces) await replay(actions);
  });
});
