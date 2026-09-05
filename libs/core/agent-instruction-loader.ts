/** PI-09: nearest AGENTS contract with per-directory override semantics. */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import type { ResourceProvenance } from './resource-provenance.js';

export interface AgentInstructionResource {
  path: string;
  content: string;
  replaced: boolean;
  provenance: ResourceProvenance;
}

function isWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function isWorktreePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate).replaceAll('\\', '/');
  return relative === '.worktrees' || relative.startsWith('.worktrees/');
}

function assertNoSymlinkTraversal(candidate: string, root: string): void {
  const relative = path.relative(root, candidate).replaceAll('\\', '/');
  if (relative === '') return;
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('[AGENT_INSTRUCTION_SCOPE] instruction path is outside the repository root');
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) break;
    if (safeLstat(current).isSymbolicLink()) {
      throw new Error(
        `[AGENT_INSTRUCTION_SYMLINK] instruction path cannot traverse a symbolic link: ${relative}`
      );
    }
  }
}

function provenanceFor(filePath: string, replaced: boolean): ResourceProvenance {
  return {
    source: 'agent-instruction-loader',
    scope: 'repository',
    origin: replaced ? 'tenant-overlay' : 'builtin',
    base_dir: path.dirname(filePath),
    trust: 'trusted',
  };
}

function assertInstructionRegularFile(filePath: string): void {
  if (!safeLstat(filePath).isFile()) {
    throw new Error(
      `[AGENT_INSTRUCTION_RESOURCE] instruction contract must be a regular file: ${filePath}`
    );
  }
}

/**
 * Resolve the nearest contract without allowing an override file inside a
 * git worktree to shadow the repository contract. An override at the nearest
 * directory replaces the nearest AGENTS.md rather than merging with it.
 */
export function loadAgentInstructionResource(
  targetPath: string = pathResolver.rootDir(),
  options: { rootDir?: string; trustResolved?: boolean } = {}
): AgentInstructionResource | null {
  const root = path.resolve(options.rootDir || pathResolver.rootDir());
  const resolvedTarget = path.resolve(targetPath);
  if (!isWithin(resolvedTarget, root)) {
    throw new Error('[AGENT_INSTRUCTION_SCOPE] target path is outside the repository root');
  }
  assertNoSymlinkTraversal(resolvedTarget, root);
  let current =
    safeExistsSync(resolvedTarget) && safeLstat(resolvedTarget).isDirectory()
      ? resolvedTarget
      : path.dirname(resolvedTarget);
  if (!safeExistsSync(current)) current = path.dirname(current);
  if (!safeExistsSync(current) || !isWithin(current, root)) current = root;
  const worktree = isWorktreePath(resolvedTarget, root);
  while (isWithin(current, root)) {
    const overridePath = path.join(current, 'AGENTS.override.md');
    const basePath = path.join(current, 'AGENTS.md');
    assertNoSymlinkTraversal(overridePath, root);
    assertNoSymlinkTraversal(basePath, root);
    // PI-03: project-local overrides are trust-sensitive executable/model
    // input. A pre-trust caller may still discover the canonical contract,
    // but must not consume an override before project trust is resolved.
    if (options.trustResolved === true && !worktree && safeExistsSync(overridePath)) {
      assertInstructionRegularFile(overridePath);
      return {
        path: overridePath,
        content: String(safeReadFile(overridePath, { encoding: 'utf8' }) || ''),
        replaced: true,
        provenance: provenanceFor(overridePath, true),
      };
    }
    if (safeExistsSync(basePath)) {
      assertInstructionRegularFile(basePath);
      return {
        path: basePath,
        content: String(safeReadFile(basePath, { encoding: 'utf8' }) || ''),
        replaced: false,
        provenance: provenanceFor(basePath, false),
      };
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
