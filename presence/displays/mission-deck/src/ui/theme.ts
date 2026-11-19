import type { AgentState, Lane, Phase } from '../model/types.js';

/**
 * Every state carries a glyph and a word — color is reinforcement only.
 */
export const theme = {
  brand: 'cyan',
  accent: 'cyan',
  muted: 'gray',
  focus: 'cyanBright',
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
  you: 'blueBright',
  kyb: 'magentaBright',
} as const;

export const LANE_GLYPH: Record<Lane, string> = {
  decide: '◆',
  review: '◇',
  blocked: '■',
  running: '⟳',
  done: '✓',
};

export const LANE_COLOR: Record<Lane, string> = {
  decide: 'yellow',
  review: 'cyan',
  blocked: 'red',
  running: 'blue',
  done: 'green',
};

export const AGENT_GLYPH: Record<AgentState, string> = {
  working: '⟳',
  blocked: '?',
  idle: '·',
  done: '✓',
  unknown: '…',
};

export const AGENT_COLOR: Record<AgentState, string> = {
  working: 'blue',
  blocked: 'yellow',
  idle: 'gray',
  done: 'green',
  unknown: 'gray',
};

export function taskGlyph(status: string): { glyph: string; color: string } {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'done':
      return { glyph: '✓', color: 'green' };
    case 'in_progress':
    case 'active':
    case 'running':
      return { glyph: '⟳', color: 'blue' };
    case 'blocked':
      return { glyph: '■', color: 'red' };
    case 'failed':
      return { glyph: '✗', color: 'red' };
    default:
      return { glyph: '○', color: 'gray' };
  }
}

export const PHASE_LABEL_KEYS: Record<Phase, `deck:phase_${Phase}`> = {
  intent: 'deck:phase_intent',
  agreed: 'deck:phase_agreed',
  executing: 'deck:phase_executing',
  review: 'deck:phase_review',
  learning: 'deck:phase_learning',
  done: 'deck:phase_done',
};
