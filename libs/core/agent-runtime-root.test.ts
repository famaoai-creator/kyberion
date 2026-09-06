import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { ensureAgentRuntimeRoot } from './agent-runtime-root.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
} from './secure-io.js';

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
    expect(safeReadFile(projected, { encoding: 'utf8' })).toContain(
      'Conversation-mode constraints:'
    );
    expect(safeReadFile(projected, { encoding: 'utf8' })).toContain(
      'Do not create files, start implementation, or begin mission work.'
    );
    expect(safeReadFile(projected, { encoding: 'utf8' })).not.toContain('Projected role guidance:');

    safeRmSync(root);
  });

  it('projects provider memory for arbitrary providers using canonical names', () => {
    const root = ensureAgentRuntimeRoot({
      agentId: 'nerve-agent',
      provider: 'nova',
      mode: 'mission',
    });

    const projected = `${root}/NOVA.md`;
    expect(safeExistsSync(projected)).toBe(true);
    expect(safeReadFile(projected, { encoding: 'utf8' })).toContain('Mode: mission');

    safeRmSync(root);
  });

  it('rejects a runtime root that traverses an existing symlink', () => {
    const base = pathResolver.sharedTmp('agent-runtime-roots');
    const root = path.join(base, 'mission', 'agent-runtime-root-symlink-test');
    const target = pathResolver.sharedTmp('agent-runtime-root-symlink-target');
    safeMkdir(path.dirname(root), { recursive: true });
    safeMkdir(target, { recursive: true });
    safeSymlinkSync(target, root, 'dir');

    try {
      expect(() =>
        ensureAgentRuntimeRoot({
          agentId: 'agent-runtime-root-symlink-test',
          provider: 'gemini',
          mode: 'mission',
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeRmSync(root, { force: true });
      safeRmSync(target, { recursive: true, force: true });
    }
  });
});
