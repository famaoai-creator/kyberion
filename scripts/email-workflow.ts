import { readEmailDraftArtifact, readGwsAuthStatus, generateEmailReplyDraft, executeGmailDelivery, resolveEmailTriagePath } from '@agent/core/email-workflow';
import { safeExistsSync, safeReadFile } from '@agent/core';

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  const [command = 'status', ...rest] = argv;
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

function getString(args: ArgMap, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(args: ArgMap, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

function readTextFileIfExists(filePath: string): string {
  if (!safeExistsSync(filePath)) return '';
  return String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (command === 'status') {
    console.log(JSON.stringify(readGwsAuthStatus(), null, 2));
    return;
  }

  if (command === 'latest-draft') {
    console.log(JSON.stringify(readEmailDraftArtifact(), null, 2));
    return;
  }

  if (command === 'draft') {
    const triageFile = getString(args, '--triage-file', resolveEmailTriagePath());
    const triageText = readTextFileIfExists(triageFile).trim();
    if (!triageText) {
      throw new Error(`triage text not found at ${triageFile}`);
    }
    const { getReasoningBackend } = await import('@agent/core');
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
    console.log(JSON.stringify(result, null, 2));
    return;
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
      throw new Error('approval is required before sending an email; add --approved or use --draft-mode');
    }
    const replyModeValue = getString(args, '--reply-mode');
    const result = await executeGmailDelivery({
      approved,
      draft_mode: draftMode,
      reply_mode: replyModeValue === 'reply' || replyModeValue === 'reply-all' ? replyModeValue : 'new',
      body_markdown: bodyMarkdown,
      subject: getString(args, '--subject'),
      to: getString(args, '--to'),
      message_id: getString(args, '--message-id'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown email workflow command: ${command}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
