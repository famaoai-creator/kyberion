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

/** What the window prints after the decision, in the operator's language (vocabulary catalog). */
export interface ApprovalWindowTexts {
  recorded: string;
  notRecorded: string;
  close: string;
}

const DEFAULT_TEXTS: ApprovalWindowTexts = {
  recorded: 'Recorded.',
  notRecorded: 'Not recorded (wrong code, timeout or refusal); nothing changed.',
  close: 'Press Enter to close this window.',
};

/** The window texts from the vocabulary catalog, in the operator's language. */
export function approvalWindowTexts(
  t: (
    key:
      | 'recorder:recorder_approval_window_recorded'
      | 'recorder:recorder_approval_window_not_recorded'
      | 'recorder:recorder_approval_window_close'
  ) => string
): ApprovalWindowTexts {
  return {
    recorded: t('recorder:recorder_approval_window_recorded'),
    notRecorded: t('recorder:recorder_approval_window_not_recorded'),
    close: t('recorder:recorder_approval_window_close'),
  };
}

/** A line `cmd.exe` echoes literally: its operators and quotes are removed. */
function cmdEchoText(text: string): string {
  return text.replace(/[\^&|<>()%!"]/gu, '');
}

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
  | { kind: 'manual'; command: string; reason: ApprovalWindowManualReason };

/** Why no window was opened; the caller shows it in the person's language. */
export type ApprovalWindowManualReason = 'unquotable_path' | 'no_os_terminal';

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
  texts?: ApprovalWindowTexts;
}): ApprovalWindowPlan {
  const { repoRoot, requestId, decision, scriptDir } = input;
  const texts = input.texts ?? DEFAULT_TEXTS;
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
      `if ${command}; then`,
      `  echo; echo ${shellQuote(texts.recorded)}`,
      'else',
      `  echo; echo ${shellQuote(texts.notRecorded)}`,
      'fi',
      `read -r -p ${shellQuote(`${texts.close} `)} _`,
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
        reason: 'unquotable_path',
      };
    }
    const scriptBody = [
      '@echo off',
      'rem Kyberion: decide one approval in this window (opened by --new-window).',
      `cd /d "${repoRoot}" || exit /b 1`,
      `call ${command}`,
      `if errorlevel 1 (echo. & echo ${cmdEchoText(texts.notRecorded)}) else (echo. & echo ${cmdEchoText(texts.recorded)})`,
      'pause',
      '',
    ].join('\r\n');
    return { kind: 'launch', scriptPath: path.join(scriptDir, `${base}.cmd`), scriptBody, command };
  }
  return {
    kind: 'manual',
    command,
    reason: 'no_os_terminal',
  };
}

/** The vocabulary key and params that tell the person what happened. */
export function approvalWindowMessage(
  plan: ApprovalWindowPlan,
  requestId: string
): {
  key: 'recorder:recorder_approval_window_opened' | 'recorder:recorder_approval_window_manual';
  params: Record<string, string>;
  reasonKey?:
    | 'recorder:recorder_approval_window_reason_unquotable_path'
    | 'recorder:recorder_approval_window_reason_no_os_terminal';
} {
  return plan.kind === 'launch'
    ? {
        key: 'recorder:recorder_approval_window_opened',
        params: { id: requestId, command: plan.command },
      }
    : {
        key: 'recorder:recorder_approval_window_manual',
        params: { command: plan.command },
        reasonKey: `recorder:recorder_approval_window_reason_${plan.reason}`,
      };
}

/** Open the decision window for this host, or return the manual instruction. */
export async function openApprovalWindow(
  requestId: string,
  decision: ApprovalWindowDecision,
  texts?: ApprovalWindowTexts
): Promise<ApprovalWindowPlan> {
  const plan = planApprovalWindow({
    platform: currentPlatform,
    repoRoot: pathResolver.rootDir(),
    requestId,
    decision,
    scriptDir: pathResolver.sharedTmp('approval-window'),
    ...(texts ? { texts } : {}),
  });
  if (plan.kind === 'manual') return plan;
  safeWriteFile(plan.scriptPath, plan.scriptBody);
  safeChmodSync(plan.scriptPath, 0o700);
  await platform.open(plan.scriptPath);
  return plan;
}
