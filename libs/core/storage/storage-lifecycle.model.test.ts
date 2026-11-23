import { describe, expect, it } from 'vitest';
import { checkFiniteStateSafety, type SafetyModel } from '../testing/finite-state-checker.js';

type Restore = {
  phase: 'initial' | 'checked' | 'installed' | 'refused';
  file: 'empty' | 'live' | 'archive';
  deleted: boolean;
};

function restoreModel(guard: 'none' | 'generation' | 'maintenance-lock'): SafetyModel<Restore> {
  return {
    initial: [{ phase: 'initial', file: 'empty', deleted: false }],
    key: (state) => JSON.stringify(state),
    next: (state) => {
      if (state.phase === 'installed' || state.phase === 'refused') return [];
      const edges = [];
      if (state.file === 'empty' && !state.deleted) {
        edges.push({ action: 'writer creates file', state: { ...state, file: 'live' as const } });
      }
      if (state.phase === 'checked' && !state.deleted && guard !== 'maintenance-lock') {
        edges.push({
          action: 'offboarding completes deletion',
          state: { ...state, deleted: true, file: 'empty' as const },
        });
      }
      if (state.phase === 'initial' && state.file === 'empty') {
        edges.push({ action: 'restore preflight', state: { ...state, phase: 'checked' as const } });
      }
      if (state.phase === 'checked') {
        const refused = state.file === 'live' || (state.deleted && guard === 'generation');
        edges.push({
          action: 'restore installs file',
          state: refused
            ? { ...state, phase: 'refused' as const }
            : { ...state, phase: 'installed' as const, file: 'archive' as const },
        });
      }
      return edges;
    },
    invariants: {
      noResurrectionAfterOffboarding: ({ deleted, file }) => !deleted || file !== 'archive',
    },
  };
}

type Publication = {
  phase: 'ready' | 'body' | 'index' | 'ownership' | 'done';
  originalBytes: number;
  bodyVersion: number;
  visibleVersion: number;
  indexAppends: number;
  ownershipAppends: number;
  interrupted: boolean;
};

function publicationModel(
  immutableBody: boolean,
  idempotentAppend: boolean
): SafetyModel<Publication> {
  return {
    initial: [
      {
        phase: 'ready',
        originalBytes: 1,
        bodyVersion: 1,
        visibleVersion: 1,
        indexAppends: 0,
        ownershipAppends: 0,
        interrupted: false,
      },
    ],
    key: (state) => JSON.stringify(state),
    next: (state) => {
      if (state.phase === 'done') return [];
      const edges: ReturnType<SafetyModel<Publication>['next']>[number][] = [];
      if (state.phase !== 'ready' && !state.interrupted) {
        edges.push({
          action: 'interrupt and retry',
          state: { ...state, interrupted: true, phase: 'ready' },
        });
      }
      switch (state.phase) {
        case 'ready':
          edges.push({
            action: 'write replacement bytes',
            state: {
              ...state,
              phase: 'body',
              bodyVersion: 2,
              originalBytes: immutableBody ? 1 : 2,
            },
          });
          break;
        case 'body':
          edges.push({
            action: 'append scope index',
            state: {
              ...state,
              phase: 'index',
              indexAppends: idempotentAppend ? 1 : state.indexAppends + 1,
            },
          });
          break;
        case 'index':
          edges.push({
            action: 'append ownership',
            state: {
              ...state,
              phase: 'ownership',
              ownershipAppends: idempotentAppend ? 1 : state.ownershipAppends + 1,
            },
          });
          break;
        case 'ownership':
          edges.push({
            action: 'publish reference',
            state: { ...state, phase: 'done', visibleVersion: 2 },
          });
      }
      return edges;
    },
    invariants: {
      referenceMatchesBytes: (state) =>
        state.visibleVersion ===
        (state.visibleVersion === 1 ? state.originalBytes : state.bodyVersion),
      oneAppendPerVersion: (state) => state.indexAppends <= 1 && state.ownershipAppends <= 1,
    },
  };
}

describe('storage lifecycle counterexamples', () => {
  it('distinguishes file exclusivity from preventing a deleted partition from returning', () => {
    const unsafe = checkFiniteStateSafety(restoreModel('none'));
    expect(unsafe).toMatchObject({
      status: 'violated',
      invariant: 'noResurrectionAfterOffboarding',
    });
    expect(unsafe.trace?.map(({ action }) => action)).toEqual([
      'initial',
      'restore preflight',
      'offboarding completes deletion',
      'restore installs file',
    ]);
    expect(checkFiniteStateSafety(restoreModel('generation')).status).toBe('verified');
    expect(checkFiniteStateSafety(restoreModel('maintenance-lock')).status).toBe('verified');
  });

  it('separates consistent replacement from idempotent index and ownership appends', () => {
    const unsafeReplacement = checkFiniteStateSafety(publicationModel(false, false));
    expect(unsafeReplacement).toMatchObject({
      status: 'violated',
      invariant: 'referenceMatchesBytes',
    });
    expect(unsafeReplacement.trace?.map(({ action }) => action)).toEqual([
      'initial',
      'write replacement bytes',
    ]);
    const unsafeRetry = checkFiniteStateSafety(publicationModel(true, false));
    expect(unsafeRetry).toMatchObject({ status: 'violated', invariant: 'oneAppendPerVersion' });
    expect(unsafeRetry.trace?.map(({ action }) => action)).toEqual([
      'initial',
      'write replacement bytes',
      'append scope index',
      'interrupt and retry',
      'write replacement bytes',
      'append scope index',
    ]);
    expect(checkFiniteStateSafety(publicationModel(true, true)).status).toBe('verified');
  });
});
