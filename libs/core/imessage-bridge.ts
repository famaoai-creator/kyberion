import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeExec, safeMkdir } from './secure-io.js';
import { toAppleScriptString, activateApplication } from './apple-event-bridge.js';

export interface IMessageSendRequest {
  recipient: string;
  text: string;
  serviceName?: string;
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

export function buildIMessageSendScript(request: IMessageSendRequest): string {
  const serviceClause = request.serviceName?.trim()
    ? `set targetService to first service whose service type contains "${toAppleScriptString(request.serviceName.trim())}"`
    : 'set targetService to first service whose service type is iMessage';
  return [
    'tell application "Messages"',
    'activate',
    serviceClause,
    `set targetBuddy to buddy "${toAppleScriptString(request.recipient.trim())}" of targetService`,
    `send "${toAppleScriptString(request.text)}" to targetBuddy`,
    'end tell',
  ].join('\n');
}

export function sendIMessage(request: IMessageSendRequest): IMessageSendResult {
  const recipient = String(request.recipient || '').trim();
  const text = String(request.text || '').trim();
  if (!recipient) {
    throw new Error('recipient is required');
  }
  if (!text) {
    throw new Error('text is required');
  }

  const eventBase = {
    ts: new Date().toISOString(),
    platform: 'imessage',
    recipient,
    text,
  };

  if (!isDarwin()) {
    const detail = 'iMessage bridge requires macOS (Darwin).';
    appendEvent({ ...eventBase, sent: false, detail });
    throw new Error(detail);
  }

  activateApplication('Messages');
  const script = buildIMessageSendScript(request);
  safeExec('osascript', ['-e', script]);
  const detail = `sent to ${recipient}`;
  appendEvent({ ...eventBase, sent: true, detail });
  logger.success(`📨 [iMessageBridge] ${detail}`);
  return {
    sent: true,
    platform: 'imessage',
    recipient,
    text,
    detail,
  };
}

export function describeIMessageBridgeHealth(): { ready: boolean; platform: string; detail: string } {
  if (!isDarwin()) {
    return {
      ready: false,
      platform: 'imessage',
      detail: 'macos_required',
    };
  }
  return {
    ready: true,
    platform: 'imessage',
    detail: 'darwin_messages_app_available',
  };
}
