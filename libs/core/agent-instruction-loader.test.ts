import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { loadAgentInstructionResource } from './agent-instruction-loader.js';

const root = pathResolver.rootResolve(`active/shared/tmp/agent-instruction-loader-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('PI-09 AGENTS override loader', () => {
  it('uses the nearest override as a replacement', () => {
    safeMkdir(path.join(root, 'src', 'nested'), { recursive: true });
    safeWriteFile(path.join(root, 'AGENTS.md'), 'root contract');
    safeWriteFile(path.join(root, 'src', 'AGENTS.override.md'), 'src contract');

    const resource = loadAgentInstructionResource(path.join(root, 'src', 'nested'), {
      rootDir: root,
    });
    expect(resource?.content).toBe('src contract');
    expect(resource?.replaced).toBe(true);
    expect(resource?.provenance.origin).toBe('tenant-overlay');
  });

  it('ignores overrides when resolving from a worktree shadow', () => {
    safeMkdir(path.join(root, '.worktrees', 'feature'), { recursive: true });
    safeWriteFile(path.join(root, 'AGENTS.md'), 'root contract');
    safeWriteFile(
      path.join(root, '.worktrees', 'feature', 'AGENTS.override.md'),
      'shadow contract'
    );

    const resource = loadAgentInstructionResource(path.join(root, '.worktrees', 'feature'), {
      rootDir: root,
    });
    expect(resource?.content).toBe('root contract');
    expect(resource?.replaced).toBe(false);
  });

  it('does not consume a project override before trust is resolved', () => {
    safeMkdir(path.join(root, 'src', 'nested'), { recursive: true });
    safeWriteFile(path.join(root, 'AGENTS.md'), 'root contract');
    safeWriteFile(path.join(root, 'src', 'AGENTS.override.md'), 'untrusted overlay');

    const resource = loadAgentInstructionResource(path.join(root, 'src', 'nested'), {
      rootDir: root,
      trustResolved: false,
    });
    expect(resource?.path).toBe(path.join(root, 'AGENTS.md'));
    expect(resource?.content).toBe('root contract');
    expect(resource?.replaced).toBe(false);
  });
});
