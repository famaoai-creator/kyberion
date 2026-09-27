import { describe, expect, it } from 'vitest';
import { main } from './codex_profile_controller.js';

describe('codex_profile_controller', () => {
  it('documents the profile lifecycle', async () => {
    const lines: string[] = [];
    await main(['help'], (value) => lines.push(String(value)));
    expect(lines.join('\n')).toContain('Usage: pnpm kyberion codex profile');
    expect(lines.join('\n')).toContain('login <name>');
    expect(lines.join('\n')).toContain('run <name>');
  });
});
