import { describe, expect, it } from 'vitest';
import {
  buildSessionPaths,
  mergeSessionSummaries,
  normalizeSessionName,
  isValidSessionId,
  parseSessionId,
  parseTerminalSessionCreateInput,
  parseTerminalSocketMessage,
  isLikelyTerminalControlPayload,
} from '../presence/bridge/terminal/session-utils.js';

describe('terminal session utils', () => {
  it('rejects unsafe session ids and malformed session creation input', () => {
    expect(isValidSessionId('s-123')).toBe(true);
    expect(isValidSessionId('../escape')).toBe(false);
    expect(parseSessionId('s-123')).toBe('s-123');
    for (const value of ['', '../escape', 'session/id', ['s-1'], 42]) {
      expect(() => parseSessionId(value)).toThrow('TERMINAL_INPUT_INVALID');
    }
    expect(parseTerminalSessionCreateInput({ name: 'Room' })).toEqual({ name: 'Room' });
    expect(() => parseTerminalSessionCreateInput(null)).toThrow('TERMINAL_INPUT_INVALID');
    expect(() => parseTerminalSessionCreateInput({ name: [] })).toThrow('TERMINAL_INPUT_INVALID');
    expect(() => parseTerminalSessionCreateInput({ id: 's-1', extra: true })).toThrow(
      'TERMINAL_INPUT_INVALID'
    );
  });

  it('validates websocket session control messages before PTY access', () => {
    expect(isLikelyTerminalControlPayload('{"type":"input"}')).toBe(true);
    expect(isLikelyTerminalControlPayload('[malformed')).toBe(true);
    expect(isLikelyTerminalControlPayload('ls\n')).toBe(false);
    expect(
      parseTerminalSocketMessage({ type: 'init', sessionId: 's-1', cols: 80, rows: 30 })
    ).toEqual({ type: 'init', sessionId: 's-1', cols: 80, rows: 30 });
    expect(parseTerminalSocketMessage({ type: 'input', data: 'ls\n' })).toEqual({
      type: 'input',
      data: 'ls\n',
    });
    expect(() => parseTerminalSocketMessage({ type: 'resize', cols: [], rows: 30 })).toThrow(
      'TERMINAL_INPUT_INVALID'
    );
    expect(() => parseTerminalSocketMessage({ type: 'input', data: { command: 'ls' } })).toThrow(
      'TERMINAL_INPUT_INVALID'
    );
  });

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
      [{ id: 's-1', name: 'Live', active_brain: 'coder', lastActive: 20, connected: true }]
    );

    expect(merged).toEqual([
      { id: 's-1', name: 'Live', active_brain: 'coder', lastActive: 20, connected: true },
      { id: 's-2', name: 'Older', active_brain: 'none', lastActive: 5, connected: false },
    ]);
  });
});
