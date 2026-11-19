/**
 * TTY handoff: run an interactive governed command with the real terminal
 * (stdio inherited) while the deck is unmounted, then return.
 *
 * Used for:
 *  - `herdr agent attach <target>` — live terminal of an agent
 *  - `kyberion approvals --approve|--deny <id>` — the governed approval CLI
 *    keeps sole ownership of principal resolution and its typed challenge.
 */
import * as path from 'node:path';
import { safeSpawn } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { safeChildEnv } from '@agent/core/foundation';
import { resolveHerdrBin } from '@agent/core/tool/tool-binary-resolvers';

export interface HandoffSpec {
  kind: 'attach' | 'approval';
  command: string;
  args: string[];
  /** Shown before the child takes the terminal. */
  banner: string;
  /** Audit metadata for the outcome record. */
  subject: string;
}

export function attachSpec(target: string, banner: string): HandoffSpec {
  return {
    kind: 'attach',
    command: resolveHerdrBin(),
    args: ['agent', 'attach', target],
    banner,
    subject: target,
  };
}

export function approvalSpec(
  requestId: string,
  decision: 'approve' | 'deny',
  banner: string
): HandoffSpec {
  return {
    kind: 'approval',
    command: 'node',
    args: [
      path.join(pathResolver.rootDir(), 'scripts', 'kyberion_cli_entry.mjs'),
      'approvals',
      decision === 'approve' ? '--approve' : '--deny',
      requestId,
    ],
    banner,
    subject: requestId,
  };
}

export type HandoffRunner = (spec: HandoffSpec) => Promise<number | null>;

export const runHandoff: HandoffRunner = (spec) =>
  new Promise((resolve) => {
    process.stdout.write(`\n${spec.banner}\n\n`);
    // Ink unrefs stdin on unmount but does not pause it; a flowing parent
    // stream would swallow keystrokes meant for the child (attach / approval
    // challenge). Ink resumes stdin on the next mount.
    process.stdin.pause();
    let child;
    try {
      child = safeSpawn(spec.command, spec.args, {
        cwd: pathResolver.rootDir(),
        env: { ...safeChildEnv() },
        stdio: 'inherit',
      });
    } catch (err) {
      process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(null);
      return;
    }
    child.on('error', (err) => {
      process.stdout.write(`${err.message}\n`);
      resolve(null);
    });
    child.on('exit', (code) => resolve(code));
  });
