import { describe, expect, it } from 'vitest';
import {
  buildSessionPaths,
  mergeSessionSummaries,
  normalizeSessionName,
} from '../presence/bridge/terminal/session-utils.js';

describe('terminal session utils', () => {
  it('builds stable session runtime paths', () => {
    const paths = buildSessionPaths('/runtime/terminal', 's-123');

    expect(paths.base).toBe('/runtime/terminal/s-123');
    expect(paths.in).toBe('/runtime/terminal/s-123/in');
    expect(paths.out).toBe('/runtime/terminal/s-123/out');
    expect(paths.state).toBe('/runtime/terminal/s-123/state.json');
  });

  it('normalizes empty and long session names', () => {
    expect(normalizeSessionName('', 's-1')).toBe('Session s-1');
    expect(normalizeSessionName('  custom room  ', 's-1')).toBe('custom room');
    expect(normalizeSessionName('x'.repeat(120), 's-1').length).toBe(80);
  });

  it('merges persisted and live session summaries with runtime precedence', () => {
    const merged = mergeSessionSummaries(
      [
        { id: 's-1', name: 'Persisted', active_brain: 'planner', lastActive: 10, connected: false },
        { id: 's-2', name: 'Older', active_brain: 'none', lastActive: 5, connected: false },
      ],
      [
        { id: 's-1', name: 'Live', active_brain: 'coder', lastActive: 20, connected: true },
      ],
    );

    expect(merged).toEqual([
      { id: 's-1', name: 'Live', active_brain: 'coder', lastActive: 20, connected: true },
      { id: 's-2', name: 'Older', active_brain: 'none', lastActive: 5, connected: false },
    ]);
  });
});
