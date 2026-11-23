import { expect, it } from 'vitest';
import type { ContextSecurityScope } from '../governance/context-security-scope.js';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import {
  assertWorkItemReviewScope,
  classifyWorkItemReview,
  workItemReviewPasses,
} from './mission-workitem-dispatch-review.js';

const base = { mission_id: 'mission', task_id: 'task', purpose: 'review' } as const;
const scopes: ContextSecurityScope[] = [
  { ...base, tenant_slug: 'tenant-a', read_tiers: ['confidential'], write_tier: 'confidential' },
  { ...base, tenant_slug: 'tenant-b', read_tiers: ['confidential'], write_tier: 'confidential' },
  {
    ...base,
    tenant_slug: 'tenant-a',
    organization_id: 'org-a',
    read_tiers: ['confidential'],
    write_tier: 'confidential',
  },
  { ...base, read_tiers: ['personal'], write_tier: 'personal' },
  { ...base, read_tiers: ['public'], write_tier: 'public' },
];

it('preserves review scope and keeps fresh self-review outside the independent gate', () => {
  type State = {
    source: number;
    target?: number;
    surface?: 'cli_subagent' | 'agent_runtime';
    sameActor?: boolean;
    sameRuntime?: boolean;
    admitted?: boolean;
    gatePassed?: boolean;
  };
  const result = checkFiniteStateSafety<State>({
    initial: scopes.map((_, source) => ({ source })),
    key: (state) => JSON.stringify(state),
    next(state) {
      if (state.target !== undefined) return [];
      return scopes.flatMap((review, target) =>
        (['cli_subagent', 'agent_runtime'] as const).flatMap((surface) =>
          [false, true].flatMap((sameActor) =>
            [false, true].map((sameRuntime) => {
              let admitted = true;
              try {
                assertWorkItemReviewScope(scopes[state.source]!, review);
              } catch {
                admitted = false;
              }
              const independence = classifyWorkItemReview({
                surface,
                implementer: 'implementer',
                reviewer: sameActor ? 'implementer' : 'reviewer',
                implementationRuntime: 'runtime-1',
                reviewRuntime: sameRuntime ? 'runtime-1' : 'runtime-2',
              });
              return {
                action: 'attempt review',
                state: {
                  ...state,
                  target,
                  surface,
                  sameActor,
                  sameRuntime,
                  admitted,
                  gatePassed: admitted && workItemReviewPasses(true, independence, true),
                },
              };
            })
          )
        )
      );
    },
    invariants: {
      scopePreserved: (state) =>
        state.target === undefined || state.admitted === (state.source === state.target),
      separateReviewerRequired: (state) =>
        state.target === undefined ||
        state.gatePassed ===
          (state.source === state.target &&
            state.surface === 'agent_runtime' &&
            !state.sameActor &&
            !state.sameRuntime),
    },
  });
  expect(result).toMatchObject({ status: 'verified', visited: 205, transitions: 200 });
});
