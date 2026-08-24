import { describe, expect, it } from 'vitest';
import { selectEntrypoint } from './kyberion.js';

describe('kyberion command router', () => {
  it('routes operator-home commands through the home entrypoint', () => {
    expect(selectEntrypoint('ask').id).toBe('operator-home');
    expect(selectEntrypoint('').id).toBe('operator-home');
  });

  it('routes catalog and workflow commands through the operator CLI', () => {
    expect(selectEntrypoint('list').id).toBe('operator-cli');
    expect(selectEntrypoint('schedule').id).toBe('operator-cli');
  });

  it('keeps unknown commands on the operator-home surface', () => {
    expect(selectEntrypoint('unknown-command').id).toBe('operator-home');
  });
});
