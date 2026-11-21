/**
 * Decide an approval in a separate terminal window (MSN-APPROVAL-UX-20261122).
 *
 * A human-only approval needs a person at an interactive terminal outside the
 * agent session (`approval-cli-decision.ts`): a command run from an agent CLI
 * (e.g. Claude Code's `!` prefix) has no TTY and a provider CLI among its
 * parents, so it is refused. `pnpm kyberion approvals --approve <id>
 * --new-window` asks the operating system to open a new terminal window that
 * runs the ordinary decision command. The OS starts that window (macOS
 * `open`, Windows `explorer`), so it has a real TTY and is not a child of the
 * agent session; the typed-code challenge runs there unchanged, and its code
 * is printed only in that window, which the agent cannot read or type into.
 *
 * Nothing here relaxes the challenge: the window runs the same command a
 * person would type. On Linux the window would be a child of this process
 * (still inside the agent lineage), so no window is opened and the person is
 * told which command to run in their own terminal.
 */
import * as path from 'node:path';
import { currentPlatform, platform } from '@agent/core/platform';
import type { Platform } from '@agent/core/platform-facts';
import * as pathResolver from '@agent/core/path-resolver';
import { safeChmodSync, safeWriteFile } from '@agent/core/secure-io';

export type ApprovalWindowDecision = 'approve' | 'deny';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type ApprovalWindowPlan =
  | {
      kind: 'launch';
      /** The script the OS opens in a new terminal window. */
      scriptPath: string;
      scriptBody: string;
      /** Same command, for the message shown here. */
      command: string;
    }
  | { kind: 'manual'; command: string; reason: string };

function decisionCommand(decision: ApprovalWindowDecision, requestId: string): string {
  return `pnpm kyberion approvals --${decision} ${requestId}`;
}

/** Single-quoted for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The window to open (or the manual instruction) for one decision. Pure:
 * the caller writes `scriptBody` to `scriptPath` and opens it.
 */
export function planApprovalWindow(input: {
  platform: Platform;
  repoRoot: string;
  requestId: string;
  decision: ApprovalWindowDecision;
  scriptDir: string;
}): ApprovalWindowPlan {
  const { repoRoot, requestId, decision, scriptDir } = input;
  if (!SAFE_REQUEST_ID.test(requestId)) {
    throw new Error(`approval request id is not a safe id: ${JSON.stringify(requestId)}`);
  }
  const command = decisionCommand(decision, requestId);
  const base = `${decision}-${requestId.replace(/[^A-Za-z0-9._-]/gu, '_')}`;
  if (input.platform === 'darwin') {
    const scriptBody = [
      '#!/bin/bash',
      '# Kyberion: decide one approval in this window (opened by --new-window).',
      `cd ${shellQuote(repoRoot)} || exit 1`,
      command,
      'echo',
      'read -r -p "Done. Press Enter to close this window." _',
      '',
    ].join('\n');
    return {
      kind: 'launch',
      scriptPath: path.join(scriptDir, `${base}.command`),
      scriptBody,
      command,
    };
  }
  if (input.platform === 'win32') {
    if (/["%^&|<>]/u.test(repoRoot)) {
      return {
        kind: 'manual',
        command,
        reason: 'the repository path contains characters a .cmd script cannot quote safely',
      };
    }
    const scriptBody = [
      '@echo off',
      'rem Kyberion: decide one approval in this window (opened by --new-window).',
      `cd /d "${repoRoot}" || exit /b 1`,
      `call ${command}`,
      'echo.',
      'pause',
      '',
    ].join('\r\n');
    return { kind: 'launch', scriptPath: path.join(scriptDir, `${base}.cmd`), scriptBody, command };
  }
  return {
    kind: 'manual',
    command,
    reason:
      'this platform has no OS-started terminal window (a window opened from here would still run inside the agent session)',
  };
}

/** The vocabulary key and params that tell the person what happened. */
export function approvalWindowMessage(
  plan: ApprovalWindowPlan,
  requestId: string
): [
  'recorder:recorder_approval_window_opened' | 'recorder:recorder_approval_window_manual',
  Record<string, string>,
] {
  return plan.kind === 'launch'
    ? ['recorder:recorder_approval_window_opened', { id: requestId, command: plan.command }]
    : ['recorder:recorder_approval_window_manual', { command: plan.command, reason: plan.reason }];
}

/** Open the decision window for this host, or return the manual instruction. */
export async function openApprovalWindow(
  requestId: string,
  decision: ApprovalWindowDecision
): Promise<ApprovalWindowPlan> {
  const plan = planApprovalWindow({
    platform: currentPlatform,
    repoRoot: pathResolver.rootDir(),
    requestId,
    decision,
    scriptDir: pathResolver.sharedTmp('approval-window'),
  });
  if (plan.kind === 'manual') return plan;
  safeWriteFile(plan.scriptPath, plan.scriptBody);
  safeChmodSync(plan.scriptPath, 0o700);
  await platform.open(plan.scriptPath);
  return plan;
}
