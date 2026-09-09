import {
  executeEmailDelivery,
  generateEmailReplyDraft,
  organizeEmailInbox,
  listEmailAccountProviders,
  readEmailDraftArtifact,
  resolveEmailTriagePath,
} from '@agent/core/email-workflow';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

type ArgMap = Record<string, string | boolean>;

const SHARED_FLAGS = new Set(['--json', '--dry-run', '--check', '--quiet']);

export function readEmailWorkflowTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help', args: {} };
  const filtered = argv.filter((arg) => !SHARED_FLAGS.has(arg));
  if (filtered[0] === '--') filtered.shift();
  const [command = 'status', ...rest] = filtered;
  const args: ArgMap = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) continue;
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      args[current] = true;
      continue;
    }
    args[current] = next;
    index += 1;
  }
  return { command, args };
}

function helpText(): string {
  return [
    'Usage: pnpm kyberion email <status|draft|latest-draft|deliver|archive-inbox> [options]',
    'Compat: pnpm email:workflow -- <same command>',
    '',
    'Inbox/triage (read) uses Google Workspace gmail_triage.',
    'Send/draft (write) uses email-actuator and stays approval-gated.',
    'See docs/EMAIL_OPERATOR.ja.md',
    '',
    'Commands:',
    '  status        Check Gmail/gws auth readiness (read path)',
    '  draft         Generate a reply draft from inbox triage (gws read)',
    '  latest-draft  Show the latest stored draft artifact',
    '  deliver       Create a Gmail draft or send an approved reply (email-actuator)',
    '  archive-inbox Organize the inbox (--account auto|gmail|outlook)',
  ].join('\n');
}

function getString(args: ArgMap, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(args: ArgMap, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

function readTextFileIfExists(filePath: string): string {
  if (!safeExistsSync(filePath)) return '';
  return readEmailWorkflowTextFile(filePath);
}

async function main(argv: string[], dryRun = false) {
  const { command, args } = parseArgs(argv);

  if (command === 'help') return helpText();

  if (command === 'status') {
    return { accounts: listEmailAccountProviders() };
  }

  if (command === 'latest-draft') {
    return readEmailDraftArtifact();
  }

  if (command === 'draft') {
    const triageFile = getString(args, '--triage-file', resolveEmailTriagePath());
    const triageText = readTextFileIfExists(triageFile).trim();
    if (!triageText) {
      throw new Error(`triage text not found at ${triageFile}`);
    }
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        action: 'draft',
        triage_path: triageFile,
        to: getString(args, '--to'),
        subject: getString(args, '--subject'),
        tone: getString(args, '--tone', 'clear and concise'),
      };
    }
    const { getReasoningBackend } = await import('@agent/core/reasoning-backend');
    const backend = getReasoningBackend();
    const result = await generateEmailReplyDraft({
      requestId: getString(args, '--request-id'),
      recipient: getString(args, '--to'),
      subjectInput: getString(args, '--subject'),
      tone: getString(args, '--tone', 'clear and concise'),
      triageText,
      delegateTask: backend.delegateTask.bind(backend),
      backendName: (backend as any)?.name || 'unknown',
    });
    return result;
  }

  if (command === 'deliver') {
    const bodyFile = getString(args, '--body-file');
    const bodyMarkdown = getString(args, '--body-markdown') || readTextFileIfExists(bodyFile);
    if (!bodyMarkdown.trim()) {
      throw new Error('body_markdown is required; provide --body-markdown or --body-file');
    }
    const draftMode = getBoolean(args, '--draft-mode');
    const approved = getBoolean(args, '--approved');
    if (!draftMode && !approved) {
      throw new Error(
        'approval is required before sending an email; add --approved or use --draft-mode'
      );
    }
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        action: 'deliver',
        draft_mode: draftMode,
        approved,
        account: getString(args, '--account') || getString(args, '--provider') || 'auto',
        to: getString(args, '--to'),
        subject: getString(args, '--subject'),
        body_chars: bodyMarkdown.length,
      };
    }
    const replyModeValue = getString(args, '--reply-mode');
    const result = await executeEmailDelivery({
      approved,
      draft_mode: draftMode,
      reply_mode:
        replyModeValue === 'reply' || replyModeValue === 'reply-all' ? replyModeValue : 'new',
      body_markdown: bodyMarkdown,
      subject: getString(args, '--subject'),
      to: getString(args, '--to'),
      message_id: getString(args, '--message-id'),
      account: getString(args, '--account') || getString(args, '--provider') || 'auto',
    });
    return result;
  }

  if (command === 'archive-inbox') {
    const result = await organizeEmailInbox({
      account: getString(args, '--account') || getString(args, '--provider') || 'auto',
      max_messages: Number(getString(args, '--max-messages', '50') || '50'),
      min_count: Number(getString(args, '--min-count', '2') || '2'),
      apply: dryRun ? false : getBoolean(args, '--apply'),
      message_ids: getString(args, '--message-ids')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    });
    return dryRun ? { ...result, dry_run: true } : result;
  }

  throw new Error(`Unknown email workflow command: ${command}`);
}

const script = defineScript({
  name: 'email:workflow',
  run: ({ argv, dryRun, check, print }) =>
    main(argv, dryRun || check).then((result) => {
      if (result !== undefined) print(result);
      return result;
    }),
});
if (
  isDirectScript(import.meta.url, 'email-workflow.ts') ||
  isDirectScript(import.meta.url, 'email-workflow.js')
) {
  void script();
}
