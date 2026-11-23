import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SafetyModel, checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  listCoordinationEvents,
  reapExpiredWorkLeases,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';

type Ticket = 1 | 2;
type Action = { kind: 'claim' | 'complete'; ticket: Ticket } | { kind: 'reap' };
type State = {
  status: 'ready' | 'in_progress' | 'done';
  issued: 0 | Ticket;
  active: Ticket | null;
  completedWith: Ticket | null;
};
const initial: State = { status: 'ready', issued: 0, active: null, completedWith: null };
const ttlMs = 1_000;
const clockStart = Date.UTC(2026, 0, 1);

function transitions(state: State, allowStaleCompletion = false) {
  const edges: { action: Action; state: State }[] = [];
  if (state.status === 'ready' && state.issued < 2) {
    const ticket = state.issued === 0 ? 1 : 2;
    edges.push({
      action: { kind: 'claim', ticket },
      state: { ...state, issued: ticket, active: ticket, status: 'in_progress' },
    });
  }
  if (state.active === 1) {
    edges.push({
      action: { kind: 'reap' },
      state: { ...state, active: null, status: 'ready' },
    });
  }
  for (const ticket of [1, 2] as const) {
    if (ticket > state.issued) continue;
    const authorized =
      state.active === ticket || (allowStaleCompletion && ticket === 1 && state.active === 2);
    edges.push({
      action: { kind: 'complete', ticket },
      state: authorized ? { ...state, active: null, status: 'done', completedWith: ticket } : state,
    });
  }
  return edges;
}

function model(allowStaleCompletion = false): SafetyModel<State> {
  return {
    initial: [initial],
    key: (state) => JSON.stringify(state),
    next: (state) =>
      transitions(state, allowStaleCompletion).map((edge) => ({
        action: edge.action.kind === 'reap' ? 'reap' : `${edge.action.kind} ${edge.action.ticket}`,
        state: edge.state,
      })),
    invariants: {
      completionUsesLatestTicket: (state) =>
        state.status !== 'done' || state.completedWith === state.issued,
      activeLeaseMatchesStatus: (state) =>
        state.status === 'in_progress' ? state.active === state.issued : state.active === null,
    },
  };
}

// Probe each rejected completion once per reachable prefix. Rejection leaves
// the state unchanged, so repeating that edge would only generate more paths.
function schedules(state: State = initial): ReturnType<typeof transitions>[] {
  return transitions(state).flatMap((edge) => [
    [edge],
    ...(edge.state === state ? [] : schedules(edge.state).map((tail) => [edge, ...tail])),
  ]);
}

const cases = ['peer-a', 'peer-b'].flatMap((secondHolder) =>
  schedules().map((path) => ({
    secondHolder,
    path,
    sequence: path
      .map(({ action }) => (action.kind === 'reap' ? 'reap' : `${action.kind} ${action.ticket}`))
      .join(' → '),
  }))
);

describe('WorkItem completion fencing model', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace('work-item-completion-model-test');
    clearWorkCoordinationStore();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('exhausts the finite model and detects a stale-completion mutation', () => {
    expect(cases).toHaveLength(20);
    expect(checkFiniteStateSafety(model())).toMatchObject({
      status: 'verified',
      visited: 6,
      transitions: 10,
    });
    const broken = checkFiniteStateSafety(model(true));
    expect(broken).toMatchObject({ status: 'violated', invariant: 'completionUsesLatestTicket' });
    expect(broken.trace?.map(({ action }) => action)).toEqual([
      'initial',
      'claim 1',
      'reap',
      'claim 2',
      'complete 1',
    ]);
  });

  it.each(cases)('$secondHolder: $sequence', ({ secondHolder, path }) => {
    vi.setSystemTime(clockStart);
    const { item_id: itemId } = createWorkItem({
      itemId: 'completion-model',
      title: 'Completion fencing',
      description: 'WorkItem lease model fixture',
      context: { project_id: 'default', work_shape: 'routine_operation' },
    });
    const tickets = new Map<Ticket, string>();
    for (const { action, state } of path) {
      const before = getWorkItem(itemId);
      if (action.kind === 'reap') {
        vi.setSystemTime(clockStart + ttlMs + 1);
        expect(
          reapExpiredWorkLeases({ itemFilter: (item) => item.item_id === itemId }).recovered
        ).toEqual([expect.objectContaining({ item_id: itemId })]);
      } else {
        const actorPeerId = action.ticket === 1 ? 'peer-a' : secondHolder;
        if (action.kind === 'claim') {
          const { lease } = claimWorkItem({ itemId, actorPeerId, purpose: 'test', ttlMs });
          expect([...tickets.values()]).not.toContain(lease.lease_id);
          tickets.set(action.ticket, lease.lease_id);
        } else {
          const complete = () =>
            releaseWorkItem({
              itemId,
              actorPeerId,
              leaseId: tickets.get(action.ticket)!,
              nextStatus: 'done',
            });
          if (before?.status !== 'done' && state.completedWith === action.ticket) {
            expect(complete().lease.lease_id).toBe(tickets.get(action.ticket));
          } else {
            const eventsBefore = listCoordinationEvents({ item_id: itemId });
            expect(complete).toThrowError(/lease/i);
            expect(getWorkItem(itemId)).toEqual(before);
            expect(listCoordinationEvents({ item_id: itemId })).toEqual(eventsBefore);
          }
        }
      }
      const actual = getWorkItem(itemId);
      const activeId = state.active === null ? undefined : tickets.get(state.active);
      expect(actual?.status).toBe(state.status);
      expect(actual?.lease_id).toBe(activeId);
      expect(
        listActiveWorkLeases()
          .filter((lease) => lease.item_id === itemId)
          .map((lease) => lease.lease_id)
      ).toEqual(activeId ? [activeId] : []);
    }
  });
});

describe('external effect recovery model', () => {
  type EffectState = {
    phase: 'running' | 'interrupted' | 'reaped' | 'settled';
    proof: boolean;
    replacementGranted: boolean;
  };

  function effectModel(allowUnverifiedRetry = false): SafetyModel<EffectState> {
    return {
      initial: [{ phase: 'running', proof: false, replacementGranted: false }],
      key: (state) => JSON.stringify(state),
      next: (state) => {
        switch (state.phase) {
          case 'running':
            return [false, true].map((proof) => ({
              action: proof
                ? 'interrupt with completion proof'
                : 'interrupt without completion proof',
              state: { ...state, proof, phase: 'interrupted' },
            }));
          case 'interrupted':
            return [
              {
                action: 'reap',
                state: { ...state, phase: state.proof ? 'settled' : 'reaped' },
              },
            ];
          case 'reaped':
          case 'settled':
            return state.replacementGranted
              ? []
              : [
                  {
                    action: 'request a replacement claim',
                    state: {
                      ...state,
                      replacementGranted: state.phase === 'settled' || allowUnverifiedRetry,
                    },
                  },
                ];
        }
      },
      invariants: {
        replacementRequiresRecoveredCompletion: (state) =>
          !state.replacementGranted || (state.proof && state.phase === 'settled'),
      },
    };
  }

  it('keeps replacement authority fenced across interruption and reaping', () => {
    expect(checkFiniteStateSafety(effectModel())).toMatchObject({
      status: 'verified',
      visited: 6,
      transitions: 6,
    });
    const broken = checkFiniteStateSafety(effectModel(true));
    expect(broken).toMatchObject({
      status: 'violated',
      invariant: 'replacementRequiresRecoveredCompletion',
    });
    expect(broken.trace?.map(({ action }) => action)).toEqual([
      'initial',
      'interrupt without completion proof',
      'reap',
      'request a replacement claim',
    ]);
  });
});
