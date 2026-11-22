/**
 * `pnpm kyberion approvals` subcommand body — extracted from kyberion_home.ts
 * to keep the home entry under the file-lines budget. `ui`/`printOutput` are
 * injected so localized strings stay identical to the home implementation.
 */
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import type { VocabularyKey } from '@agent/core/t';
import {
  decideApprovalFromCli,
  findRevocableApproval,
  revokeApprovalFromCli,
} from './approval-cli-decision.js';
import { delegateApprovalToCharter } from './approval-cli-delegate.js';
import { ScriptExitError } from './harness.js';

export type ApprovalsArgv = Partial<
  Record<'approve' | 'deny' | 'revoke' | 'delegate' | 'expires-at' | 'reason' | 'note', string>
> & {
  json?: boolean;
  /** Decide in a new OS-started terminal window (approval-terminal-window.ts). */
  'new-window'?: boolean;
};

export type ApprovalsUi = (key: VocabularyKey, params?: Record<string, string | number>) => string;

export async function handleApprovalsSubcommand(
  argv: ApprovalsArgv,
  ui: ApprovalsUi,
  printOutput: (value: unknown) => void
): Promise<void> {
  if (argv.revoke) {
    const requestId = String(argv.revoke);
    const request = findRevocableApproval(requestId);
    if (!request) {
      printOutput(ui('recorder:recorder_approvals_revoke_not_found', { id: requestId }));
      throw new ScriptExitError(1, '', true);
    }
    const revoked = revokeApprovalFromCli(request, { reason: argv.reason || argv.note });
    const { id, title } = revoked;
    printOutput(ui('recorder:recorder_approval_updated', { id, title, status: 'revoked' }));
    return;
  }
  const pending = listApprovalRequests({ status: 'pending' });
  if (argv.delegate) {
    const requestId = String(argv.delegate);
    const request = pending.find((entry) => entry.id === requestId);
    if (!request) {
      printOutput(ui('recorder:recorder_approvals_not_found', { id: requestId }));
      throw new ScriptExitError(1, '', true);
    }
    // The stored target was derived server-side from the trusted effect at
    // request time and is re-validated inside before any grant is composed.
    if (!delegateApprovalToCharter(request, argv['expires-at'], printOutput).ok)
      throw new ScriptExitError(1, '', true);
    return;
  }
  if (argv.approve || argv.deny) {
    const requestId = String(argv.approve || argv.deny);
    const request = pending.find((entry) => entry.id === requestId);
    if (!request) {
      printOutput(ui('recorder:recorder_approvals_not_found', { id: requestId }));
      throw new ScriptExitError(1, '', true);
    }
    if (argv['new-window']) {
      // The decision itself runs in the new window (real TTY, outside this session).
      const win = await import('./approval-terminal-window.js');
      const decision = argv.approve ? 'approve' : 'deny';
      const plan = await win.openApprovalWindow(requestId, decision, win.approvalWindowTexts(ui));
      const message = win.approvalWindowMessage(plan, requestId);
      const reason = message.reasonKey ? { reason: ui(message.reasonKey) } : {};
      return void printOutput(ui(message.key, { ...message.params, ...reason }));
    }
    const decided = await decideApprovalFromCli(request, {
      decision: argv.approve ? 'approved' : 'rejected',
      note: argv.note || 'decided via pnpm kyberion approvals',
    });
    printOutput(
      ui('recorder:recorder_approval_updated', {
        id: decided.id,
        status: decided.status,
        title: decided.title,
      })
    );
    return;
  }
  if (argv.json) {
    printOutput(JSON.stringify(pending, null, 2));
    return;
  }
  if (pending.length === 0) {
    printOutput(ui('recorder:recorder_approvals_empty'));
    return;
  }
  printOutput(ui('recorder:recorder_approvals_header', { count: pending.length }));
  for (const request of pending) {
    printOutput(`  ● [${request.id}] ${request.title}`);
    if (request.summary) printOutput(`      ${String(request.summary).slice(0, 120)}`);
    // Deciding requires seeing the effect: render the request details (what
    // changes, who asked, what approval enables) inline so `approvals` alone
    // is enough to make an informed decision without opening the store file.
    if (request.details) {
      for (const line of String(request.details).split('\n')) {
        printOutput(`      ${line}`);
      }
    }
    printOutput(
      `      requested by ${request.requestedBy}${request.requestedByDisplayName ? ` (${request.requestedByDisplayName})` : ''} via ${request.channel} at ${request.requestedAt}`
    );
  }
  printOutput('');
  printOutput(ui('recorder:recorder_approvals_summary'));
}
