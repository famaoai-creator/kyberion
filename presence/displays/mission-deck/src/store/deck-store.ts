/**
 * UI state lives outside React so it survives the unmount/remount that a TTY
 * handoff (attach / governed approval CLI) requires.
 */
import { EMPTY_SNAPSHOT, type DeckSnapshot, type MissionDetail } from '../model/types.js';
import type { ViewId } from '../model/layout.js';
import type { HandoffSpec } from '../actions/handoff.js';

export type Focus = 'rail' | 'main' | 'agents' | 'composer';

export interface Turn {
  who: 'you' | 'kyb' | 'sys';
  text: string;
  at: number;
  /** Intent summary attached to a Kyberion reply. */
  intent?: { understood?: string; shape?: string; next?: string; missing?: string[] };
  /** Decision id rendered inline as a card. */
  decisionId?: string;
}

export type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'palette'; query: string; index: number }
  | { kind: 'peek'; target: string; draft: string }
  | {
      kind: 'steer';
      target: { kind: 'mission'; missionId: string } | { kind: 'agent'; target: string };
      draft: string;
    }
  | {
      kind: 'confirm';
      /** What happens on `y`. */
      action:
        | { kind: 'approval'; id: string; decision: 'approve' | 'deny' }
        | { kind: 'interrupt'; target: string }
        | { kind: 'pause'; missionId: string };
      text: string;
    };

export interface Toast {
  ok: boolean;
  text: string;
  at: number;
}

export interface DeckState {
  snapshot: DeckSnapshot;
  loaded: boolean;
  view: ViewId;
  focus: Focus;
  railKey?: string;
  railIndex: number;
  agentIndex: number;
  transcript: Turn[];
  draft: string;
  busy: boolean;
  overlay: Overlay;
  toast?: Toast;
  details: Record<string, MissionDetail | null>;
  threadTs: string;
  /** Decision ids already announced (inline card + OSC 9). */
  announced: string[];
  /** Set when the app asks the runner to hand the TTY to a child. */
  handoff?: HandoffSpec;
  quitting: boolean;
}

export const MAX_TRANSCRIPT = 200;

export function initialDeckState(overrides: Partial<DeckState> = {}): DeckState {
  return {
    snapshot: EMPTY_SNAPSHOT,
    loaded: false,
    view: 'conversation',
    focus: 'composer',
    railIndex: 0,
    agentIndex: 0,
    transcript: [],
    draft: '',
    busy: false,
    overlay: { kind: 'none' },
    details: {},
    threadTs: `deck-${Date.now().toString(36)}`,
    announced: [],
    quitting: false,
    ...overrides,
  };
}

export class DeckStore {
  private state: DeckState;
  private listeners = new Set<() => void>();

  constructor(initial: DeckState = initialDeckState()) {
    this.state = initial;
  }

  getState = (): DeckState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(update: Partial<DeckState> | ((state: DeckState) => Partial<DeckState>)): void {
    const patch = typeof update === 'function' ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  pushTurn(turn: Omit<Turn, 'at'>): void {
    this.set((state) => ({
      transcript: [...state.transcript, { ...turn, at: Date.now() }].slice(-MAX_TRANSCRIPT),
    }));
  }

  toast(ok: boolean, text: string): void {
    this.set({ toast: { ok, text, at: Date.now() } });
  }
}
