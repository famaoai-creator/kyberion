/** Offline fixture hook only. No production budget or provider qualification is supplied. */
import {
  getUsageAttribution,
  withUsageAttribution,
  type UsageAttribution,
} from '../usage-accounting.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import { rereadOwnDotCharter, type DotCharter, type LoadedDotCharter } from './dot-charter.js';
import type { DotProposal } from './dot-proposals.js';
import {
  observeDotSemanticJudgment,
  type DotSemanticJudgmentDeps,
} from './dot-semantic-judgment.js';

export interface DotWakeSemanticFixtureInjection {
  qualification: 'offline_fixture';
  deps: DotSemanticJudgmentDeps;
}
/** Internal runtime capture; failures disable observation and never affect baseline work. */
export interface DotWakeSemanticCapture {
  charter(value: DotCharter): void;
  usage(): void;
  proposals(value: readonly DotProposal[]): void;
}
interface ObserverDeps {
  now?: () => Date;
  semanticJudgment?: DotWakeSemanticFixtureInjection;
}
function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Baseline is invoked synchronously; fresh off/missing qualification never reads observer ports. */
export function withDotWakeSemanticObserver<T extends { outcome: string }, D extends ObserverDeps>(
  loaded: LoadedDotCharter,
  deps: D,
  run: (capture: DotWakeSemanticCapture, baselineDeps: Omit<D, 'semanticJudgment'>) => Promise<T>
): Promise<T> {
  let enabled = false;
  let failed = false;
  let charter: DotCharter | undefined;
  let charterHash = '';
  let usage: UsageAttribution | undefined;
  let proposals: DotProposal[] = [];
  let fixture: DotSemanticJudgmentDeps | undefined;
  let start = 0;
  let last = 0;
  let deadline = 0;
  let parentClock: (() => Date) | undefined;
  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch {
      failed = true;
      enabled = false;
    }
  };
  const now = (): number => {
    const value = parentClock?.().getTime();
    if (value === undefined || !Number.isFinite(value) || value < last)
      throw new Error('Invalid parent clock');
    last = value;
    return value;
  };
  const capture: DotWakeSemanticCapture = {
    charter: (value) =>
      guarded(() => {
        if (value.status !== 'active' || value.runtime.semantic_judgment?.mode !== 'shadow') return;
        const injected = deps.semanticJudgment;
        const budget = value.goal.budget?.wall_clock_ms_per_wake;
        if (
          injected?.qualification !== 'offline_fixture' ||
          !deps.now ||
          !Number.isFinite(budget) ||
          !budget ||
          budget <= 0
        )
          return;
        fixture = injected.deps;
        if (
          !fixture.schedule ||
          !fixture.canEvaluate ||
          !fixture.prepare ||
          !fixture.persist ||
          fixture.budget?.mode !== 'offline_fixture' ||
          fixture.invoke?.mode !== 'offline_fixture'
        )
          return;
        parentClock = deps.now.bind(deps);
        // The observer clock is always derived from the original runtime Date clock.
        start = now();
        deadline = start + budget;
        if (!Number.isFinite(deadline)) return;
        charter = detached(value);
        charterHash = judgmentCanonicalHash(charter);
        enabled = true;
      }),
    usage: () =>
      guarded(() => {
        if (enabled && !usage) {
          const current = getUsageAttribution();
          if (!current?.accounting_id || current.actor_id !== `dot:${charter?.dot_id}`)
            throw new Error('Missing original parent');
          usage = detached(current);
        }
      }),
    proposals: (value) =>
      guarded(() => {
        if (enabled) proposals = detached(value) as DotProposal[];
      }),
  };
  // Existing runtime spreads deps into ledger/tool contexts. Never enumerate fixture ports there.
  let baselineDeps: Omit<D, 'semanticJudgment'> = deps;
  if (Object.hasOwn(deps, 'semanticJudgment')) {
    const descriptors = Object.getOwnPropertyDescriptors(deps);
    delete descriptors.semanticJudgment;
    baselineDeps = Object.create(Object.getPrototypeOf(deps), descriptors) as Omit<
      D,
      'semanticJudgment'
    >;
  }
  const baseline = run(capture, baselineDeps);
  if (!enabled) return baseline;
  return baseline.then(async (receipt) => {
    try {
      if (
        failed ||
        receipt.outcome !== 'delivered' ||
        !charter ||
        !usage?.accounting_id ||
        !fixture
      )
        return receipt;
      const canEvaluate = (): boolean => {
        try {
          const current = rereadOwnDotCharter(loaded);
          return (
            now() < deadline &&
            current.status === 'active' &&
            current.runtime.semantic_judgment?.mode === 'shadow' &&
            judgmentCanonicalHash(detached(current)) === charterHash &&
            fixture?.canEvaluate?.() === true
          );
        } catch {
          return false;
        }
      };
      if (!canEvaluate()) return receipt;
      await withUsageAttribution(usage, () =>
        observeDotSemanticJudgment(
          {
            mode: 'shadow',
            parent: {
              dot_id: charter.dot_id,
              accounting_id: usage.accounting_id!,
              scope: charter.scope,
              day: new Date(start).toISOString().slice(0, 10),
              deadline_ms: deadline,
              baseline_complete: true,
            },
            proposals,
          },
          { ...fixture, now, canEvaluate }
        )
      );
    } catch {
      /* Advisory failures cannot change baseline delivery. */
    }
    return receipt;
  });
}
