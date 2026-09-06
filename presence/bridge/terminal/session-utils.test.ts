import { describe, expect, it } from 'vitest';
import { parsePersistedSessionState, parseTerminalControlRequest } from './session-utils.js';

describe('terminal watcher control request boundary', () => {
  it('accepts a text request', () => {
    expect(parseTerminalControlRequest({ text: 'run status' })).toEqual({ text: 'run status' });
  });

  it('normalizes stimulus and brain profile identifiers', () => {
    expect(
      parseTerminalControlRequest({ stimulus_id: '  stim-1  ', brain_profile: '  default  ' })
    ).toEqual({ stimulus_id: 'stim-1', brain_profile: 'default' });
    expect(parseTerminalControlRequest({ stimulus_id: 'stim-2' })).toEqual({
      stimulus_id: 'stim-2',
    });
  });

  it('rejects malformed types and unknown fields', () => {
    expect(parseTerminalControlRequest(null)).toBeNull();
    expect(parseTerminalControlRequest({ text: 123 })).toBeNull();
    expect(parseTerminalControlRequest({ stimulus_id: '   ' })).toBeNull();
    expect(parseTerminalControlRequest({ text: 'x', extra: true })).toBeNull();
  });

  it('rejects empty and oversized requests', () => {
    expect(parseTerminalControlRequest({ text: '' })).toBeNull();
    expect(parseTerminalControlRequest({ text: 'x'.repeat(100_001) })).toBeNull();
  });
});

describe('terminal persisted session state boundary', () => {
  it('accepts the state written by the terminal bridge', () => {
    expect(
      parsePersistedSessionState({
        id: 'session-1',
        name: 'Operator shell',
        ts: '2026-09-01T00:00:00.000Z',
        pid: 123,
        active: false,
        active_brain: 'default',
        lastActive: 1_757_000_000_000,
        createdAt: '2026-08-31T00:00:00.000Z',
        connected: false,
      })
    ).toMatchObject({ id: 'session-1', name: 'Operator shell', active: false });
  });

  it('rejects malformed state before restore and pruning decisions', () => {
    expect(parsePersistedSessionState([])).toBeNull();
    expect(parsePersistedSessionState({ id: '../escape', name: 'bad' })).toBeNull();
    expect(parsePersistedSessionState({ id: 'session-1', name: 'bad', active: 'true' })).toBeNull();
    expect(parsePersistedSessionState({ id: 'session-1', name: 'bad', lastActive: -1 })).toBeNull();
    expect(parsePersistedSessionState({ id: 'session-1', name: 'bad', extra: true })).toBeNull();
  });

  it('rejects dangerous persisted object keys before normalization', () => {
    expect(
      parsePersistedSessionState({
        id: 'session-1',
        name: 'bad',
        metadata: { ['__proto__']: { polluted: true } },
      })
    ).toBeNull();
  });
});
