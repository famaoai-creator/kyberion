import { describe, expect, it } from 'vitest';
import { resolveCommand, selectEntrypoint } from './kyberion.js';

describe('kyberion command router', () => {
  it('routes operator-home commands through the home entrypoint', () => {
    expect(selectEntrypoint('ask').id).toBe('operator-home');
    expect(selectEntrypoint('').id).toBe('operator-home');
  });

  it('routes catalog and workflow commands through the operator CLI', () => {
    expect(selectEntrypoint('list').id).toBe('operator-cli');
    expect(selectEntrypoint('schedule').id).toBe('operator-cli');
  });

  it('rejects unknown commands instead of falling back to an executable surface', () => {
    expect(() => selectEntrypoint('unknown-command')).toThrow('Unknown kyberion command');
  });

  it('fails closed when the command registry and entrypoint map disagree', () => {
    expect(() =>
      selectEntrypoint('ask', {
        version: 1,
        commands: [
          {
            id: 'operator-home.ask',
            command: 'ask',
            noun: 'ask',
            verb: 'default',
            entry: 'operator-home',
            audience: 'user',
          },
        ],
        entrypoints: [{ id: 'operator-home', module: 'scripts/kyberion_home.ts', commands: [''] }],
      })
    ).toThrow('CLI command registry mismatch');
  });

  it('exposes command metadata from the governed registry', () => {
    expect(resolveCommand('ask')).toMatchObject({
      noun: 'ask',
      verb: 'default',
      entry: 'operator-home',
      audience: 'user',
    });
  });
});
