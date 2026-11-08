import { describe, expect, it } from 'vitest';
import { checkFiniteStateSafety, type SafetyModel } from '../testing/finite-state-checker.js';
import { runAdfLifecycle } from './adf-lifecycle.js';

// Independent specification: no production transition logic is imported here.
type Hook = 'draft' | 'preflight' | 'repair' | 'reflight' | 'commit' | 'execute';
type Phase = Hook | 'done' | 'failed';
interface State {
  phase: Phase;
  repair: boolean;
  calls: Hook[];
  completed: Hook[];
}
const success: Record<Hook, Phase> = {
  draft: 'preflight',
  preflight: 'commit',
  repair: 'reflight',
  reflight: 'commit',
  commit: 'execute',
  execute: 'done',
};
function advance(state: State, ok: boolean): State {
  const hook = state.phase as Hook;
  return {
    ...state,
    phase: ok ? success[hook] : hook === 'preflight' && state.repair ? 'repair' : 'failed',
    calls: [...state.calls, hook],
    completed: ok ? [...state.completed, hook] : state.completed,
  };
}
const terminal = (state: State) => state.phase === 'done' || state.phase === 'failed';
const initial = (repair: boolean): State => ({ phase: 'draft', repair, calls: [], completed: [] });
const model: SafetyModel<State> = {
  initial: [initial(false), initial(true)],
  key: (state) => JSON.stringify(state),
  next: (state) =>
    terminal(state)
      ? []
      : [true, false].map((ok) => ({
          action: `${state.phase}:${ok ? 'ok' : 'error'}`,
          state: advance(state, ok),
        })),
  invariants: {
    'execute requires successful commit': (s) =>
      !s.calls.includes('execute') || s.completed.includes('commit'),
    'commit requires successful validation': (s) =>
      !s.calls.includes('commit') ||
      s.completed.includes('preflight') ||
      s.completed.includes('reflight'),
    'revalidation requires successful repair': (s) =>
      !s.calls.includes('reflight') || s.completed.includes('repair'),
    'repair happens at most once': (s) => s.calls.filter((x) => x === 'repair').length <= 1,
    'failed repair or revalidation cannot commit': (s) =>
      !(
        (s.calls.includes('repair') && !s.completed.includes('repair')) ||
        (s.calls.includes('reflight') && !s.completed.includes('reflight'))
      ) || !s.calls.includes('commit'),
    'success requires successful execute': (s) =>
      s.phase !== 'done' || s.completed.includes('execute'),
  },
};

describe('ADF lifecycle finite-state specification', () => {
  it('exhausts the reachable graph without a safety violation', () => {
    const result = checkFiniteStateSafety(model);
    expect(result).toEqual({ status: 'verified', visited: 26, transitions: 24 });
  });

  it('detects a validator bypass mutation with a counterexample', () => {
    const result = checkFiniteStateSafety({
      ...model,
      next: (state) =>
        state.phase === 'preflight'
          ? [{ action: 'bypass-validation', state: { ...state, phase: 'execute' as const } }]
          : model.next(state),
    });
    expect(result.status).toBe('violated');
    expect(result.trace?.map((x) => x.action)).toContain('bypass-validation');
  });

  // Six binary outcomes, repair present/absent, synchronous/asynchronous hooks.
  // Unreachable outcomes deliberately remain in the enumeration.
  for (const asynchronous of [false, true]) {
    for (const repair of [false, true]) {
      it(`matches production for all 64 outcome assignments (async=${asynchronous}, repair=${repair})`, async () => {
        const hooks: Hook[] = ['draft', 'preflight', 'repair', 'reflight', 'commit', 'execute'];
        for (let mask = 0; mask < 64; mask++) {
          const ok = (hook: Hook) => (mask & (1 << hooks.indexOf(hook))) !== 0;
          let expected = initial(repair);
          while (!terminal(expected)) expected = advance(expected, ok(expected.phase as Hook));
          const calls: Hook[] = [];
          const failures = Object.fromEntries(
            hooks.map((hook) => [hook, new Error(`${hook} failure: ${mask}`)])
          ) as Record<Hook, Error>;
          const invoke = (hook: Hook, value: unknown): unknown => {
            calls.push(hook);
            if (asynchronous)
              return ok(hook) ? Promise.resolve(value) : Promise.reject(failures[hook]);
            if (!ok(hook)) throw failures[hook];
            return value;
          };
          const draft = { kind: 'draft' };
          const repaired = { kind: 'repaired' };
          const prepared = { kind: 'prepared' };
          const committed = { kind: 'committed' };
          let preflights = 0;
          let observedError: unknown;
          let resolved = false;
          try {
            const result = await runAdfLifecycle({
              draft: () => invoke('draft', draft),
              preflight: (input) => {
                expect(input).toBe(preflights === 0 ? draft : repaired);
                return invoke(preflights++ === 0 ? 'preflight' : 'reflight', prepared);
              },
              ...(repair
                ? {
                    autoRepair: (input: unknown, error: unknown) => {
                      expect(input).toBe(draft);
                      expect(error).toBe(failures.preflight);
                      return invoke('repair', repaired);
                    },
                  }
                : {}),
              commit: (input) => {
                expect(input).toBe(prepared);
                return invoke('commit', committed);
              },
              execute: (input) => {
                expect(input).toBe(committed);
                return invoke('execute', 'result');
              },
            });
            resolved = true;
            expect(result.result).toBe('result');
            expect(result.phases).toEqual(
              expected.completed.map((hook) => ({
                phase: hook === 'repair' ? 'auto-repair' : hook === 'reflight' ? 'preflight' : hook,
                status: 'completed',
              }))
            );
          } catch (error) {
            observedError = error;
          }
          expect(calls, `mask=${mask}`).toEqual(expected.calls);
          expect(resolved, `mask=${mask}`).toBe(expected.phase === 'done');
          expect(observedError).toBe(
            expected.phase === 'done' ? undefined : failures[expected.calls.at(-1)!]
          );
        }
      });
    }
  }
});
