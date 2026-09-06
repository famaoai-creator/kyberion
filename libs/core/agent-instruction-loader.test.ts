import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
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
      trustResolved: true,
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

  it('does not consume a project override when trust is omitted', () => {
    safeMkdir(path.join(root, 'src', 'nested'), { recursive: true });
    safeWriteFile(path.join(root, 'AGENTS.md'), 'root contract');
    safeWriteFile(path.join(root, 'src', 'AGENTS.override.md'), 'untrusted overlay');

    const resource = loadAgentInstructionResource(path.join(root, 'src', 'nested'), {
      rootDir: root,
    });
    expect(resource?.path).toBe(path.join(root, 'AGENTS.md'));
    expect(resource?.content).toBe('root contract');
    expect(resource?.replaced).toBe(false);
  });

  it('rejects a directory used as a trusted override contract', () => {
    safeMkdir(path.join(root, 'src', 'AGENTS.override.md'), { recursive: true });
    safeWriteFile(path.join(root, 'AGENTS.md'), 'root contract');

    expect(() =>
      loadAgentInstructionResource(path.join(root, 'src'), {
        rootDir: root,
        trustResolved: true,
      })
    ).toThrow('[AGENT_INSTRUCTION_RESOURCE] instruction contract must be a regular file');
  });

  it('rejects symlinked instruction targets and contracts', () => {
    const realDir = path.join(root, 'real');
    const linkedDir = path.join(root, 'linked');
    safeMkdir(realDir, { recursive: true });
    safeWriteFile(path.join(realDir, 'AGENTS.md'), 'external contract');
    safeSymlinkSync(realDir, linkedDir);

    expect(() =>
      loadAgentInstructionResource(path.join(linkedDir, 'nested'), { rootDir: root })
    ).toThrow('[AGENT_INSTRUCTION_SYMLINK]');

    const src = path.join(root, 'src');
    safeMkdir(src, { recursive: true });
    safeSymlinkSync(path.join(realDir, 'AGENTS.md'), path.join(src, 'AGENTS.md'));
    expect(() => loadAgentInstructionResource(src, { rootDir: root })).toThrow(
      '[AGENT_INSTRUCTION_SYMLINK]'
    );
  });
});
