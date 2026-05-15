import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createStandardYargs,
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  runSurfaceMessageConversation,
  safeReadFile,
} from '@agent/core';

export interface TelegramUser {
  id: number | string;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramBridgeInput {
  action?: 'send' | 'webhook';
  chatId?: string | number;
  text?: string;
  parseMode?: string;
  update?: TelegramUpdate;
}

export interface TelegramBridgeOptions {
  token?: string;
  apiBaseUrl?: string;
  parseMode?: string;
  dryRun?: boolean;
}

export interface TelegramSendReceipt {
  ok: boolean;
  dryRun: boolean;
  chatId: string;
  text: string;
  response?: unknown;
  reason?: string;
}

export interface TelegramWebhookReceipt {
  ok: boolean;
  ignored?: boolean;
  reason?: string;
  chatId?: string;
  messageId?: string;
  threadTs?: string;
  text?: string;
  reply?: TelegramSendReceipt;
}

const TELEGRAM_SURFACE_AGENT_ID = 'telegram-surface-agent';
const TELEGRAM_THREAD_HISTORY_ROOT = 'active/shared/runtime/telegram-bridge/thread-history';

export interface TelegramThreadHistoryEntry {
  role: 'user' | 'assistant';
  authorLabel: string;
  text: string;
  messageId: string;
  threadTs: string;
  chatId: string;
  receivedAt: string;
}

function resolveUpdate(raw: TelegramBridgeInput | TelegramUpdate): TelegramUpdate {
  if (typeof raw === 'object' && raw && ('message' in raw || 'edited_message' in raw)) {
    return raw as TelegramUpdate;
  }
  return (raw as TelegramBridgeInput).update || {};
}

function pickMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message || update.edited_message;
}

function pickText(message: TelegramMessage): string {
  return (message.text || message.caption || '').trim();
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveTelegramThreadTs(message: TelegramMessage): string {
  const chatId = String(message.chat.id);
  const threadId = message.message_thread_id;
  return typeof threadId === 'number' ? `${chatId}:${threadId}` : chatId;
}

function resolveTelegramThreadHistoryPath(threadTs: string): string {
  const safeThreadTs = sanitizePathSegment(threadTs);
  return pathResolver.resolve(`${TELEGRAM_THREAD_HISTORY_ROOT}/${safeThreadTs}.jsonl`);
}

function readTelegramThreadHistory(threadTs: string): TelegramThreadHistoryEntry[] {
  const resolved = resolveTelegramThreadHistoryPath(threadTs);
  if (!safeExistsSync(resolved)) return [];
  const raw = String(safeReadFile(resolved, { encoding: 'utf8' }) || '').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TelegramThreadHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TelegramThreadHistoryEntry => Boolean(entry));
}

function appendTelegramThreadHistory(entry: TelegramThreadHistoryEntry): void {
  try {
    const resolved = resolveTelegramThreadHistoryPath(entry.threadTs);
    safeMkdir(path.dirname(resolved), { recursive: true });
    safeAppendFileSync(resolved, `${JSON.stringify(entry)}\n`);
  } catch (error: any) {
    logger.warn(`⚠️ [TelegramBridge] Failed to persist thread history: ${error?.message || error}`);
  }
}

export function buildTelegramThreadContextFromEntries(
  entries: TelegramThreadHistoryEntry[],
): string | undefined {
  const recent = entries
    .filter((entry) => entry.text.trim().length > 0)
    .slice(-6);

  if (!recent.length) return undefined;

  return [
    'Recent Telegram thread context:',
    ...recent.map((entry) => (
      entry.role === 'assistant'
        ? `Assistant: ${entry.text}`
        : `User (${entry.authorLabel}): ${entry.text}`
    )),
  ].join('\n');
}

function buildTelegramThreadContext(threadTs: string): string | undefined {
  return buildTelegramThreadContextFromEntries(readTelegramThreadHistory(threadTs));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

function resolveToken(input?: string): string | undefined {
  return input || process.env.TELEGRAM_BOT_TOKEN || undefined;
}

export async function sendTelegramMessage(
  input: { chatId: string | number; text: string; parseMode?: string },
  options: TelegramBridgeOptions = {},
): Promise<TelegramSendReceipt> {
  const token = resolveToken(options.token);
  const dryRun = typeof options.dryRun === 'boolean'
    ? options.dryRun || !token || process.env.TELEGRAM_DRY_RUN === '1'
    : !token || process.env.TELEGRAM_DRY_RUN === '1';
  const chatId = String(input.chatId);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      chatId,
      text: input.text,
      reason: token ? 'dry_run_enabled' : 'missing_token',
    };
  }

  const apiBaseUrl = (options.apiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
  const response = await fetch(`${apiBaseUrl}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: input.text,
      parse_mode: input.parseMode || options.parseMode || 'Markdown',
    }),
  });
  const body = await response.json().catch(() => null) as any;
  if (!response.ok || body?.ok === false) {
    throw new Error(`Telegram send failed: ${response.status} ${body?.description || response.statusText}`);
  }
  return {
    ok: true,
    dryRun: false,
    chatId,
    text: input.text,
    response: body?.result,
  };
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  options: TelegramBridgeOptions = {},
): Promise<TelegramWebhookReceipt> {
  const message = pickMessage(update);
  if (!message) {
    return { ok: true, ignored: true, reason: 'no_message' };
  }
  if (message.from?.is_bot) {
    return { ok: true, ignored: true, reason: 'bot_message' };
  }

  const text = pickText(message);
  if (!text) {
    return { ok: true, ignored: true, reason: 'no_text' };
  }

  const chatId = String(message.chat.id);
  const threadTs = resolveTelegramThreadTs(message);
  const receivedAt = typeof message.date === 'number'
    ? new Date(message.date * 1000).toISOString()
    : new Date().toISOString();
  const authorLabel = String(message.from?.username || message.from?.id || chatId);

  logger.info(`📥 [TelegramBridge] Message from ${message.from?.username || message.from?.id || chatId}: ${text}`);
  const threadContext = buildTelegramThreadContext(threadTs);
  appendTelegramThreadHistory({
    role: 'user',
    authorLabel,
    text,
    messageId: String(message.message_id),
    threadTs,
    chatId,
    receivedAt,
  });

  const conversation = await runSurfaceMessageConversation({
    surface: 'telegram',
    text,
    channel: chatId,
    threadTs,
    correlationId: `telegram-${message.message_id}`,
    receivedAt,
    actorId: String(message.from?.id || chatId),
    senderAgentId: 'kyberion:telegram-bridge',
    agentId: TELEGRAM_SURFACE_AGENT_ID,
    threadContext: threadContext || undefined,
    delegationSummaryInstruction: 'Produce a concise Telegram reply. Use markdown if useful. Do not use A2A blocks.',
  } as any);

  let reply: TelegramSendReceipt | undefined;
  if (conversation.text) {
    logger.info(`📤 [TelegramBridge] Replying to ${chatId}: ${conversation.text}`);
    reply = await sendTelegramMessage(
      { chatId, text: conversation.text, parseMode: options.parseMode },
      options,
    );
    appendTelegramThreadHistory({
      role: 'assistant',
      authorLabel: TELEGRAM_SURFACE_AGENT_ID,
      text: conversation.text,
      messageId: `reply-${message.message_id}`,
      threadTs,
      chatId,
      receivedAt: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    chatId,
    messageId: String(message.message_id),
    threadTs,
    text: conversation.text,
    reply,
  };
}

async function handleInputFile(inputPath: string, options: TelegramBridgeOptions): Promise<void> {
  const resolved = pathResolver.rootResolve(inputPath);
  const parsed = JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as TelegramBridgeInput | TelegramUpdate;

  if ('action' in parsed && parsed.action === 'send') {
    const payload = await sendTelegramMessage(
      {
        chatId: parsed.chatId || '',
        text: parsed.text || '',
        parseMode: parsed.parseMode,
      },
      options,
    );
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const receipt = await handleTelegramUpdate(resolveUpdate(parsed), options);
  console.log(JSON.stringify(receipt, null, 2));
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', description: 'Read a Telegram bridge payload from a JSON file' })
    .option('port', { type: 'number', default: Number(process.env.TELEGRAM_BRIDGE_PORT || '3035') })
    .option('token', { type: 'string', description: 'Telegram Bot API token' })
    .option('api-base-url', { type: 'string', default: process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org' })
    .option('parse-mode', { type: 'string', default: process.env.TELEGRAM_PARSE_MODE || 'Markdown' })
    .option('dry-run', { type: 'boolean', default: process.env.TELEGRAM_DRY_RUN === '1' || !process.env.TELEGRAM_BOT_TOKEN })
    .option('webhook-path', { type: 'string', default: process.env.TELEGRAM_WEBHOOK_PATH || '/webhook' })
    .parseSync();

  const options: TelegramBridgeOptions = {
    token: argv.token as string | undefined,
    apiBaseUrl: argv['api-base-url'] as string | undefined,
    parseMode: argv['parse-mode'] as string | undefined,
    dryRun: Boolean(argv['dry-run']),
  };

  if (argv.input) {
    await handleInputFile(String(argv.input), options);
    return;
  }

  if (options.dryRun || !resolveToken(options.token)) {
    logger.warn('⚠️ [TelegramBridge] Running in dry-run mode because TELEGRAM_BOT_TOKEN is not configured.');
  }

  const webhookPath = String(argv['webhook-path'] || '/webhook');
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      if (req.method === 'GET' && url === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'telegram-bridge',
          surface: 'telegram',
          dryRun: options.dryRun || !resolveToken(options.token),
        });
        return;
      }
      if (req.method === 'POST' && url === webhookPath) {
        const body = (await readJsonBody(req)) as TelegramUpdate;
        const receipt = await handleTelegramUpdate(body, options);
        sendJson(res, 200, receipt);
        return;
      }
      if (req.method === 'POST' && url === '/send') {
        const body = (await readJsonBody(req)) as TelegramBridgeInput;
        const payload = await sendTelegramMessage(
          { chatId: body.chatId || '', text: body.text || '', parseMode: body.parseMode },
          options,
        );
        sendJson(res, 200, payload);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error: any) {
      logger.error(`❌ [TelegramBridge] Request failed: ${error?.message || error}`);
      sendJson(res, 400, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  });

  const port = Number(argv.port || process.env.TELEGRAM_BRIDGE_PORT || 3035);
  server.listen(port, '127.0.0.1', () => {
    logger.success(`📨 [TelegramBridge] listening on http://127.0.0.1:${port}`);
  });
}

const directEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (directEntry && !process.env.VITEST) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
