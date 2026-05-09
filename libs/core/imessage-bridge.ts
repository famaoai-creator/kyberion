import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeExec, safeMkdir } from './secure-io.js';

export interface IMessageSendRequest {
  recipient: string; // Identifier (phone, email) or Chat ID
  text: string;
  serviceName?: string; // imessage or sms
  chatId?: string; // Optional explicit chat ID for imsg
}

export interface IMessageSendResult {
  sent: boolean;
  platform: 'imessage';
  recipient: string;
  text: string;
  detail: string;
}

const IMESSAGE_LOG_PATH = pathResolver.shared('runtime/imessage-bridge/events.jsonl');

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

/**
 * imsg を使用してメッセージを送信する
 */
export function sendIMessage(request: IMessageSendRequest): IMessageSendResult {
  const recipient = String(request.recipient || '').trim();
  const text = String(request.text || '').trim();
  
  if (!recipient && !request.chatId) {
    throw new Error('recipient or chatId is required');
  }
  if (!text) {
    throw new Error('text is required');
  }

  const eventBase = {
    ts: new Date().toISOString(),
    platform: 'imessage',
    recipient: recipient || `chat:${request.chatId}`,
    text,
  };

  if (!isDarwin()) {
    const detail = 'iMessage bridge requires macOS (Darwin).';
    appendEvent({ ...eventBase, sent: false, detail });
    throw new Error(detail);
  }

  try {
    const args = ['send'];
    if (request.chatId) {
      args.push('--chat-id', request.chatId);
    } else {
      args.push('--to', recipient);
    }
    
    if (request.serviceName) {
      args.push('--service', request.serviceName.toLowerCase());
    }
    
    args.push('--text', text);

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

export function describeIMessageBridgeHealth(): { ready: boolean; platform: string; detail: string } {
  if (!isDarwin()) {
    return {
      ready: false,
      platform: 'imessage',
      detail: 'macos_required',
    };
  }
  try {
    safeExec('imsg', ['--version']);
    return {
      ready: true,
      platform: 'imessage',
      detail: 'imsg_cli_available',
    };
  } catch (err) {
    return {
      ready: false,
      platform: 'imessage',
      detail: 'imsg_cli_not_found',
    };
  }
}

/**
 * Legacy script builder (no longer used by sendIMessage but kept for potential JXA needs)
 */
export function buildIMessageSendScript(request: { recipient: string; text: string; serviceName?: string }): string {
  return `tell application "Messages" to send "${request.text.replace(/"/g, '\\"')}" to buddy "${request.recipient}"`;
}
