import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import {
  evaluateBlueBubblesConfiguration,
  type BlueBubblesConfigurationReport,
} from './bluebubbles-adapter.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeExec,
  safeMkdir,
  validateFileSize,
} from './secure-io.js';

export interface IMessageSendRequest {
  recipient: string; // Identifier (phone, email) or Chat ID
  text: string;
  serviceName?: string; // imessage or sms
  chatId?: string; // Optional explicit chat ID for imsg
  /** Absolute or workspace-relative regular files to send as attachments. */
  attachments?: string[];
}

export interface IMessageSendResult {
  sent: boolean;
  platform: 'imessage';
  recipient: string;
  text: string;
  detail: string;
}

export interface IMessageCliCapabilities {
  adapter: 'imsg' | 'none';
  send_text: boolean;
  send_attachments: boolean;
  receive_attachments: boolean;
  group_target: boolean;
}

export type IMessageProcessingResult = 'processed' | 'ignored' | 'duplicate' | 'failed';

/**
 * Advance the Messages DB polling cursor only after a message was handled.
 *
 * A failed turn releases its dedup key and must be seen again on the next
 * tick. Keeping this rule in a pure helper prevents adapters from advancing
 * the cursor before an awaited processing operation has settled.
 */
export function advanceIMessagePollCursor(
  lastSeenId: number,
  messageId: number,
  result: IMessageProcessingResult
): number {
  if (result === 'failed' || !Number.isFinite(messageId)) return lastSeenId;
  return Math.max(lastSeenId, messageId);
}

/**
 * Build a reply target that preserves the incoming chat thread.
 *
 * A chat id must win over the sender address: using the sender for a group
 * message silently turns a group reply into a one-to-one DM.
 */
export function buildIMessageReplyRequest(
  input: { sender: string; chatId?: string },
  text: string
): IMessageSendRequest {
  const chatId = String(input.chatId || '').trim();
  return chatId
    ? { recipient: '', chatId, text }
    : { recipient: String(input.sender || '').trim(), text };
}

const IMESSAGE_LOG_PATH = pathResolver.shared('runtime/imessage-bridge/events.jsonl');
const MAX_IMESSAGE_ATTACHMENTS = 8;
const MAX_IMESSAGE_ATTACHMENT_SIZE_MB = 100;

function isDarwin(): boolean {
  return process.platform === 'darwin';
}

function ensureLogDir(): void {
  const dir = path.dirname(IMESSAGE_LOG_PATH);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
}

function appendEvent(event: Record<string, unknown>): void {
  ensureLogDir();
  safeAppendFileSync(IMESSAGE_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8');
}

/** Derive capability truth from the installed imsg subcommand help text. */
export function deriveIMessageCliCapabilities(
  sendHelp: string,
  historyHelp: string
): Omit<IMessageCliCapabilities, 'adapter'> {
  return {
    // The send command itself is the text contract; keep this true even when
    // a distro omits --text from its abbreviated help output.
    send_text: /\bsend\b/u.test(sendHelp) || sendHelp.trim().length === 0,
    send_attachments: /(?:^|[^a-zA-Z0-9_-])--file\b/mu.test(sendHelp),
    receive_attachments: /(?:^|[^a-zA-Z0-9_-])--attachments?\b/mu.test(historyHelp),
    group_target: /(?:^|[^a-zA-Z0-9_-])--chat-(?:id|identifier|guid)\b/mu.test(sendHelp),
  };
}

function unavailableIMessageCapabilities(): IMessageCliCapabilities {
  return {
    adapter: 'none',
    send_text: false,
    send_attachments: false,
    receive_attachments: false,
    group_target: false,
  };
}

/** Build the public imsg command without invoking the external CLI. */
export function buildIMessageSendArgs(
  request: Pick<
    IMessageSendRequest,
    'recipient' | 'chatId' | 'text' | 'serviceName' | 'attachments'
  >
): string[] {
  const recipient = String(request.recipient || '').trim();
  const chatId = String(request.chatId || '').trim();
  const text = String(request.text || '').trim();
  const rawAttachments = request.attachments === undefined ? [] : request.attachments;
  if (!Array.isArray(rawAttachments)) throw new Error('attachments must be an array');
  const attachments = rawAttachments.map((value) => String(value).trim());

  if (!recipient && !chatId) throw new Error('recipient or chatId is required');
  if (!text && attachments.length === 0) throw new Error('text or attachment is required');
  if (attachments.some((value) => !value)) throw new Error('attachment path must not be empty');
  if (attachments.length > MAX_IMESSAGE_ATTACHMENTS) {
    throw new Error(`too many attachments (max ${MAX_IMESSAGE_ATTACHMENTS})`);
  }

  const args = ['send'];
  if (chatId) args.push('--chat-id', chatId);
  else args.push('--to', recipient);
  if (request.serviceName) args.push('--service', request.serviceName.toLowerCase());
  if (text) args.push('--text', text);
  for (const attachment of attachments) args.push('--file', attachment);
  return args;
}

function validateIMessageAttachments(attachments: unknown = []): string[] {
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  return attachments.map((rawPath) => {
    const requestedPath = String(rawPath || '').trim();
    if (!requestedPath) throw new Error('attachment path must not be empty');
    const filePath = pathResolver.resolve(requestedPath);
    if (!filePath || !safeExistsSync(filePath)) {
      throw new Error(`iMessage attachment not found: ${rawPath}`);
    }
    validateFileSize(filePath, MAX_IMESSAGE_ATTACHMENT_SIZE_MB);
    return filePath;
  });
}

/**
 * imsg を使用してメッセージを送信する
 */
export function sendIMessage(request: IMessageSendRequest): IMessageSendResult {
  const recipient = String(request.recipient || '').trim();
  const text = String(request.text || '').trim();
  const attachments = validateIMessageAttachments(request.attachments);
  const normalizedRequest = { ...request, recipient, text, attachments };
  buildIMessageSendArgs(normalizedRequest);

  const eventBase = {
    ts: new Date().toISOString(),
    platform: 'imessage',
    recipient: recipient || `chat:${request.chatId}`,
    text,
    attachment_count: attachments.length,
  };

  if (!isDarwin()) {
    const detail = 'iMessage bridge requires macOS (Darwin).';
    appendEvent({ ...eventBase, sent: false, detail });
    throw new Error(detail);
  }

  try {
    const args = buildIMessageSendArgs(normalizedRequest);

    safeExec('imsg', args);

    const detail = `sent to ${recipient || request.chatId} via imsg`;
    appendEvent({ ...eventBase, sent: true, detail });
    logger.success(`📨 [iMessageBridge] ${detail}`);

    return {
      sent: true,
      platform: 'imessage',
      recipient: recipient || request.chatId!,
      text,
      detail,
    };
  } catch (err: any) {
    const detail = `failed to send via imsg: ${err.message}`;
    appendEvent({ ...eventBase, sent: false, detail });
    throw new Error(detail);
  }
}

export function describeIMessageBridgeHealth(): {
  ready: boolean;
  platform: string;
  detail: string;
  capabilities: IMessageCliCapabilities;
  bluebubbles: BlueBubblesConfigurationReport;
} {
  const bluebubbles = evaluateBlueBubblesConfiguration();
  if (!isDarwin()) {
    return {
      ready: false,
      platform: 'imessage',
      detail: 'macos_required',
      capabilities: unavailableIMessageCapabilities(),
      bluebubbles,
    };
  }
  try {
    safeExec('imsg', ['--version']);
    const sendHelp = (() => {
      try {
        return String(safeExec('imsg', ['send', '--help']));
      } catch {
        return '';
      }
    })();
    const historyHelp = (() => {
      try {
        return String(safeExec('imsg', ['history', '--help']));
      } catch {
        return '';
      }
    })();
    return {
      ready: true,
      platform: 'imessage',
      detail: 'imsg_cli_available',
      capabilities: {
        adapter: 'imsg',
        ...deriveIMessageCliCapabilities(sendHelp, historyHelp),
      },
      bluebubbles,
    };
  } catch (err) {
    return {
      ready: false,
      platform: 'imessage',
      detail: 'imsg_cli_not_found',
      capabilities: unavailableIMessageCapabilities(),
      bluebubbles,
    };
  }
}

/**
 * Legacy script builder (no longer used by sendIMessage but kept for potential JXA needs)
 */
export function buildIMessageSendScript(request: {
  recipient: string;
  text: string;
  serviceName?: string;
}): string {
  return `tell application "Messages" to send "${request.text.replace(/"/g, '\\"')}" to buddy "${request.recipient}"`;
}
