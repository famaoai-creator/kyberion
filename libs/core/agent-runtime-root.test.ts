import { describe, expect, it } from 'vitest';
import { ensureAgentRuntimeRoot } from './agent-runtime-root.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

describe('agent-runtime-root', () => {
  it('projects provider memory into an isolated runtime root', () => {
    const root = ensureAgentRuntimeRoot({
      agentId: 'nerve-agent',
      provider: 'gemini',
      mode: 'conversation',
      channel: 'slack',
      thread: '1773596968.921969',
      systemPrompt: 'Return direct conversational answers only.',
    });

    const projected = `${root}/GEMINI.md`;
    expect(safeExistsSync(projected)).toBe(true);
    expect(safeReadFile(projected, { encoding: 'utf8' })).toContain('Conversation-mode constraints:');
    expect(safeReadFile(projected, { encoding: 'utf8' })).toContain('Do not create files, start implementation, or begin mission work.');
    expect(safeReadFile(projected, { encoding: 'utf8' })).not.toContain('Projected role guidance:');

    safeRmSync(root);
  });
});
