import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { installProcessGuards } from '@agent/core/process-guards';
import {
  appendJsonLine,
  parseSafeJsonInput,
  parseSafeJsonObjectValue,
  readJson,
  readJsonLines,
} from '@agent/core/foundation';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { t } from '@agent/core/t';
import { createStandardYargs } from '@agent/core/cli-utils';
import { startBridgeTypingLoop } from '@agent/core/bridge-typing';
import { logger } from '@agent/core/core';
import * as pathResolver from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
} from '@agent/core/secure-io';
import {
  formatChannelThreadContext,
  runChannelTurn,
  type ChannelAdapter,
} from '@agent/core/channel-adapter';
import {
  buildBridgeEmptyReplyText,
  chunkSurfaceMessage,
  isSurfaceFormatError,
  postBridgeError,
  stripSurfaceMarkup,
} from '@agent/core/bridge-error-reply';
import { resolveCustomerBinding } from '@agent/core/customer-channel-binding';
import { runCustomerConversation } from '@agent/core/customer-conversation';
import { createSurfaceOutboxDrainGuard, drainSurfaceOutbox } from '@agent/core/surface-delivery';
import {
  resolveMissionProposalReply,
  stashMissionProposalForConfirmation,
} from '@agent/core/surface-mission-proposals';
import {
  buildSurfaceApprovalActions,
  buildSurfaceApprovalText,
  createSurfaceApprovalRequest,
  resolveSurfaceApprovalReply,
  runSurfaceMessageConversation,
} from '@agent/core/channel-surface';
import { evaluateSurfaceActorAccess } from '@agent/core/surface-access-policy';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('telegram-bridge');

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

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramBridgeInput {
  action?: 'send' | 'webhook';
  chatId?: string | number;
  text?: string;
  parseMode?: string;
  update?: TelegramUpdate;
}

export interface TelegramSendInput {
  chatId: string | number;
  text: string;
  parseMode?: string;
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

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
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

export function parseTelegramThreadHistoryEntry(value: unknown): TelegramThreadHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : undefined;
  const stringField = (field: string): string | undefined =>
    typeof record[field] === 'string' ? record[field] : undefined;
  const authorLabel = stringField('authorLabel');
  const text = stringField('text');
  const messageId = stringField('messageId');
  const threadTs = stringField('threadTs');
  const chatId = stringField('chatId');
  const receivedAt = stringField('receivedAt');
  if (!role || !authorLabel || !text || !messageId || !threadTs || !chatId || !receivedAt)
    return null;
  return {
    role,
    authorLabel,
    text,
    messageId,
    threadTs,
    chatId,
    receivedAt,
  };
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

function parseTelegramApiResponse(value: unknown): TelegramApiResponse {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ok: typeof record.ok === 'boolean' ? record.ok : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    result: record.result,
  };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  return readJsonLines<TelegramThreadHistoryEntry>(resolved, {
    onMalformed: 'skip',
    map: (value) => {
      const entry = parseTelegramThreadHistoryEntry(value);
      if (!entry) throw new Error('invalid Telegram thread history entry');
      return entry;
    },
  });
}

function appendTelegramThreadHistory(entry: TelegramThreadHistoryEntry): void {
  try {
    const resolved = resolveTelegramThreadHistoryPath(entry.threadTs);
    safeMkdir(path.dirname(resolved), { recursive: true });
    appendJsonLine(resolved, entry);
  } catch (error: unknown) {
    logger.warn(`⚠️ [TelegramBridge] Failed to persist thread history: ${errorDetail(error)}`);
  }
}

export function buildTelegramThreadContextFromEntries(
  entries: TelegramThreadHistoryEntry[]
): string | undefined {
  return formatChannelThreadContext('Telegram', entries);
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
  return parseSafeJsonInput(raw, 'request body');
}

/** Keep HTTP bridge entrypoints on a single JSON-object input boundary. */
export async function readTelegramJsonObject(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const value = await readJsonBody(req);
  return parseSafeJsonObjectValue(value, 'request body');
}

export function parseTelegramSendInput(value: unknown): TelegramSendInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('telegram send input must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find(
    (key) => !['chatId', 'text', 'parseMode'].includes(key)
  );
  if (unexpected) throw new Error(`unexpected telegram send field: ${unexpected}`);

  const chatId = record.chatId;
  if (!(
    (typeof chatId === 'string' && chatId.trim().length > 0 && chatId.length <= 128) ||
    (typeof chatId === 'number' && Number.isSafeInteger(chatId))
  )) {
    throw new Error('telegram send chatId must be a non-empty string or safe integer');
  }
  const text = record.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    throw new Error('telegram send text must be a non-empty string up to 20000 characters');
  }
  const parseMode = record.parseMode;
  let normalizedParseMode: string | undefined;
  if (parseMode !== undefined) {
    if (typeof parseMode !== 'string' || parseMode.length > 32) {
      throw new Error('telegram send parseMode must be a string up to 32 characters');
    }
    normalizedParseMode = parseMode;
  }
  return {
    chatId: typeof chatId === 'string' ? chatId.trim() : chatId,
    text,
    ...(normalizedParseMode !== undefined ? { parseMode: normalizedParseMode } : {}),
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

function resolveToken(input?: string): string | undefined {
  return input || process.env.TELEGRAM_BOT_TOKEN || undefined;
}

async function sendTelegramMessageSingle(
  input: {
    chatId: string | number;
    text: string;
    parseMode?: string;
    replyMarkup?: unknown;
  },
  options: TelegramBridgeOptions = {}
): Promise<TelegramSendReceipt> {
  const token = resolveToken(options.token);
  const dryRun =
    typeof options.dryRun === 'boolean'
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
  let response = await fetch(`${apiBaseUrl}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: input.text,
      parse_mode: input.parseMode || options.parseMode || 'Markdown',
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
    }),
  });
  let body = parseTelegramApiResponse(await response.json().catch(() => null));

  if (!response.ok || body?.ok === false) {
    const description = body?.description || response.statusText || '';
    if (
      isSurfaceFormatError(
        { status: response.status, message: description },
        { surface: 'telegram' }
      )
    ) {
      logger.warn(
        `⚠️ [TelegramBridge] Markdown parsing failed, retrying as plain text: ${description}`
      );
      response = await fetch(`${apiBaseUrl}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: stripSurfaceMarkup(input.text),
          ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
        }),
      });
      body = parseTelegramApiResponse(await response.json().catch(() => null));
    }
  }

  if (!response.ok || body?.ok === false) {
    throw new Error(
      `Telegram send failed: ${response.status} ${body?.description || response.statusText}`
    );
  }
  return {
    ok: true,
    dryRun: false,
    chatId,
    text: input.text,
    response: body?.result,
  };
}

/** Send a provider-sized sequence while keeping the public receipt contract. */
export async function sendTelegramMessage(
  input: {
    chatId: string | number;
    text: string;
    parseMode?: string;
    replyMarkup?: unknown;
  },
  options: TelegramBridgeOptions = {}
): Promise<TelegramSendReceipt> {
  const chunks = chunkSurfaceMessage(input.text, 'telegram');
  let lastReceipt: TelegramSendReceipt | undefined;
  for (const [index, chunk] of chunks.entries()) {
    lastReceipt = await sendTelegramMessageSingle(
      {
        ...input,
        text: chunk,
        // Attach actions to the last chunk so long descriptions still have
        // exactly one actionable message.
        replyMarkup: index === chunks.length - 1 ? input.replyMarkup : undefined,
      },
      options
    );
  }
  return { ...lastReceipt!, text: input.text };
}

/**
 * UX-02: fire-and-forget typing action. Dry-run / missing-token setups
 * no-op (same contract as sendTelegramMessage).
 */
export async function sendTelegramTypingAction(
  chatId: string,
  options: TelegramBridgeOptions = {}
): Promise<void> {
  const token = resolveToken(options.token);
  if (options.dryRun || !token) return;
  const apiBaseUrl = (options.apiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
  await fetch(`${apiBaseUrl}/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  });
}

async function answerTelegramCallbackQuery(
  callbackQueryId: string,
  options: TelegramBridgeOptions
): Promise<void> {
  const token = resolveToken(options.token);
  if (options.dryRun || !token) return;
  const apiBaseUrl = (options.apiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
  await fetch(`${apiBaseUrl}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

function buildTelegramApprovalReplyMarkup(
  record: Awaited<ReturnType<typeof createSurfaceApprovalRequest>>
) {
  return {
    inline_keyboard: [
      buildSurfaceApprovalActions(record).map((action) => ({
        text: t(
          action.decision === 'approved'
            ? 'bridge:approval_approve_button'
            : 'bridge:approval_reject_button',
          undefined,
          resolveOperatorLocale()
        ),
        callback_data: action.callbackData,
      })),
    ],
  };
}

export async function handleTelegramCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
  options: TelegramBridgeOptions = {}
): Promise<TelegramWebhookReceipt> {
  const message = callbackQuery.message;
  if (!message || !callbackQuery.data) {
    await answerTelegramCallbackQuery(callbackQuery.id, options).catch(() => undefined);
    return { ok: true, ignored: true, reason: 'invalid_callback_query' };
  }
  const senderId = String(callbackQuery.from?.id || '');
  const access = evaluateSurfaceActorAccess('telegram', senderId);
  if (!access.allowed) {
    await answerTelegramCallbackQuery(callbackQuery.id, options).catch(() => undefined);
    return { ok: true, ignored: true, reason: 'unauthorized_sender' };
  }
  const chatId = String(message.chat.id);
  const threadTs = resolveTelegramThreadTs(message);
  const approvalReply = resolveSurfaceApprovalReply({
    surface: 'telegram',
    channel: chatId,
    threadTs,
    text: callbackQuery.data,
    decidedBy: senderId || chatId,
  });
  await answerTelegramCallbackQuery(callbackQuery.id, options).catch((error) => {
    logger.warn(`⚠️ [TelegramBridge] Callback acknowledgement failed: ${String(error)}`);
  });
  if (!approvalReply.handled) {
    return { ok: true, ignored: true, reason: 'unsupported_callback' };
  }
  const reply = await sendTelegramMessage({ chatId, text: approvalReply.reply || '' }, options);
  return { ok: true, chatId, threadTs, reply };
}

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  options: TelegramBridgeOptions = {}
): Promise<TelegramWebhookReceipt> {
  if (update.callback_query) {
    return handleTelegramCallbackQuery(update.callback_query, options);
  }
  const message = pickMessage(update);
  if (!message) {
    return { ok: true, ignored: true, reason: 'no_message' };
  }
  if (message.from?.is_bot) {
    return { ok: true, ignored: true, reason: 'bot_message' };
  }

  // Config-driven allowlist (was a hardcoded personal user id). Comma-separated
  // E2E-06: bound customer chats run in customer mode BEFORE the operator
  // allowlist — a customer is not an operator and must not be silently denied.
  const customerChatId = String(message.chat.id);
  const customerBinding = resolveCustomerBinding('telegram', customerChatId);
  if (customerBinding) {
    const text = pickText(message);
    if (!text) return { ok: true, ignored: true, reason: 'no_text' };
    try {
      const conversation = await runCustomerConversation({
        binding: customerBinding,
        text,
        actorId: String(message.from?.id || customerChatId),
        threadTs: resolveTelegramThreadTs(message),
        correlationId: `telegram-${message.message_id}`,
      });
      const reply = conversation.text
        ? await sendTelegramMessage({ chatId: customerChatId, text: conversation.text }, options)
        : undefined;
      return {
        ok: true,
        chatId: customerChatId,
        messageId: String(message.message_id),
        text: conversation.text,
        reply,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`❌ [TelegramBridge] Customer conversation failed: ${detail}`);
      await postBridgeError({
        conversationKey: `telegram-customer:${customerChatId}`,
        err,
        surface: 'telegram',
        locale: customerBinding.binding.language || 'ja',
        post: (errorText) =>
          sendTelegramMessage({ chatId: customerChatId, text: errorText }, options),
      });
      return { ok: false, chatId: customerChatId, reason: 'customer_conversation_failed' };
    }
  }

  const senderId = String(message.from?.id || '');
  const access = evaluateSurfaceActorAccess('telegram', senderId);
  if (!access.configured && !access.allowed) {
    logger.warn(
      '⚠️ [TelegramBridge] Surface allowlist is not configured — denying all senders. Set KYBERION_SURFACE_ALLOWLISTS or TELEGRAM_ALLOWED_USER_IDS.'
    );
    return { ok: true, ignored: true, reason: 'allowlist_unconfigured' };
  }
  if (!access.allowed) {
    logger.warn(
      `⚠️ [TelegramBridge] Ignored unauthorized message from sender: ${senderId} (${access.reason})`
    );
    return { ok: true, ignored: true, reason: 'unauthorized_sender' };
  }

  const text = pickText(message);
  if (!text) {
    return { ok: true, ignored: true, reason: 'no_text' };
  }

  const chatId = String(message.chat.id);
  const threadTs = resolveTelegramThreadTs(message);
  const receivedAt =
    typeof message.date === 'number'
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString();
  const authorLabel = String(message.from?.username || message.from?.id || chatId);

  logger.info(
    `📥 [TelegramBridge] Message from ${message.from?.username || message.from?.id || chatId}: ${text}`
  );

  const approvalReply = resolveSurfaceApprovalReply({
    surface: 'telegram',
    channel: chatId,
    threadTs,
    text,
    decidedBy: senderId || chatId,
  });
  if (approvalReply.handled) {
    const reply = await sendTelegramMessage({ chatId, text: approvalReply.reply || '' }, options);
    return { ok: true, chatId, messageId: String(message.message_id), threadTs, reply };
  }

  // SN-01 Phase 2: numbered-choice mission-proposal confirmation, same UX
  // contract as Slack ('1 / 作成する' issues, '2 / やめる' cancels).
  const proposalReply = await resolveMissionProposalReply({
    surface: 'telegram',
    channel: chatId,
    thread: threadTs,
    text,
  });
  if (proposalReply.handled) {
    const reply = await sendTelegramMessage({ chatId, text: proposalReply.reply }, options);
    return { ok: true, chatId, messageId: String(message.message_id), threadTs, reply };
  }

  // m1: read the thread context BEFORE persisting this message. Appending
  // first leaked the incoming message into its own context and evicted a real
  // prior turn from the 6-entry window.
  const priorThreadContext = buildTelegramThreadContext(threadTs);
  appendTelegramThreadHistory({
    role: 'user',
    authorLabel,
    text,
    messageId: String(message.message_id),
    threadTs,
    chatId,
    receivedAt,
  });

  let conversation: Awaited<ReturnType<typeof runSurfaceMessageConversation>>;
  let deliveredReply: TelegramSendReceipt | undefined;
  const channelAdapter: ChannelAdapter = {
    channel: 'telegram',
    actorId: String(message.from?.id || chatId),
    threadContext: () => priorThreadContext || undefined,
    typing: () =>
      startBridgeTypingLoop(
        'telegram-bridge',
        () => sendTelegramTypingAction(chatId, options),
        4000
      ),
    shouldSend: ({ result }) =>
      !result.missionProposals?.length && result.approvalRequests.length === 0,
    send: async ({ text: replyText }) => {
      deliveredReply = await sendTelegramMessage(
        { chatId, text: replyText, parseMode: options.parseMode },
        options
      );
      appendTelegramThreadHistory({
        role: 'assistant',
        authorLabel: TELEGRAM_SURFACE_AGENT_ID,
        text: replyText,
        messageId: `reply-${message.message_id}`,
        threadTs,
        chatId,
        receivedAt: new Date().toISOString(),
      });
    },
  };
  let postTurnReceipt: TelegramWebhookReceipt | undefined;
  try {
    conversation = await runChannelTurn(
      channelAdapter,
      { text, channel: chatId, threadTs },
      ({ threadContext }) =>
        runSurfaceMessageConversation({
          surface: 'telegram',
          text,
          channel: chatId,
          threadTs,
          correlationId: `telegram-${message.message_id}`,
          receivedAt,
          actorId: String(message.from?.id || chatId),
          senderAgentId: 'kyberion:telegram-bridge',
          agentId: TELEGRAM_SURFACE_AGENT_ID,
          threadContext,
          delegationSummaryInstruction:
            'Produce a concise Telegram reply. Use markdown if useful. Do not use A2A blocks.',
        }),
      {
        // UX-02: the typing loop must outlive the proposal/approval envelopes
        // this bridge posts itself once the turn returns.
        afterTurn: async (result) => {
          // SN-01 Phase 2: a mission proposal from the orchestrator becomes a
          // pending numbered-choice confirmation, exactly like the Slack flow.
          const missionProposal = result.missionProposals?.[0];
          if (missionProposal) {
            const prompt = stashMissionProposalForConfirmation({
              surface: 'telegram',
              channel: chatId,
              thread: threadTs,
              proposal: missionProposal,
              sourceText: text,
              routingDecision: result.routingDecision,
              fallbackSummary: result.text,
              intentResolution: result.intentResolution,
            });
            const reply = await sendTelegramMessage({ chatId, text: prompt }, options);
            appendTelegramThreadHistory({
              role: 'assistant',
              authorLabel: TELEGRAM_SURFACE_AGENT_ID,
              text: prompt,
              messageId: `reply-${message.message_id}`,
              threadTs,
              chatId,
              receivedAt: new Date().toISOString(),
            });
            postTurnReceipt = {
              ok: true,
              chatId,
              messageId: String(message.message_id),
              threadTs,
              reply,
            };
            return;
          }

          if (result.approvalRequests.length > 0) {
            let reply: TelegramSendReceipt | undefined;
            for (const draft of result.approvalRequests) {
              const record = createSurfaceApprovalRequest({
                surface: 'telegram',
                channel: chatId,
                threadTs,
                correlationId: `telegram-${message.message_id}`,
                requestedBy: TELEGRAM_SURFACE_AGENT_ID,
                draft,
                sourceText: text,
              });
              reply = await sendTelegramMessage(
                {
                  chatId,
                  text: buildSurfaceApprovalText('telegram', record, result.intentResolution),
                  replyMarkup: buildTelegramApprovalReplyMarkup(record),
                },
                options
              );
            }
            postTurnReceipt = {
              ok: true,
              chatId,
              messageId: String(message.message_id),
              threadTs,
              reply,
            };
            return;
          }

          // UX-01: an empty agent reply must not read as silence. Trim first so a
          // whitespace-only reply matches the shared channel-adapter delivery gate.
          if (!result.text.trim()) {
            deliveredReply = await sendTelegramMessage(
              { chatId, text: buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() }) },
              options
            );
          }
        },
      }
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`❌ [TelegramBridge] Conversation failed for ${chatId}: ${detail}`);
    // UX-01: the user must not be left in silence (rate-limited per thread).
    await postBridgeError({
      conversationKey: `telegram:${chatId}:${threadTs}`,
      err,
      surface: 'telegram',
      locale: resolveOperatorLocale(),
      post: (errorText) => sendTelegramMessage({ chatId, text: errorText }, options),
    });
    return {
      ok: false,
      chatId,
      messageId: String(message.message_id),
      threadTs,
      reason: 'conversation_failed',
    };
  }

  if (postTurnReceipt) return postTurnReceipt;

  return {
    ok: true,
    chatId,
    messageId: String(message.message_id),
    threadTs,
    text: conversation.text,
    reply: deliveredReply,
  };
}

export function resolveTelegramBridgeInputPath(inputPath: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(inputPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`Telegram bridge input must be an existing regular file: ${inputPath}`);
  }
  return resolved;
}

async function handleInputFile(inputPath: string, options: TelegramBridgeOptions): Promise<void> {
  const resolved = resolveTelegramBridgeInputPath(inputPath);
  const parsed = readJson<TelegramBridgeInput | TelegramUpdate>(resolved);

  if ('action' in parsed && parsed.action === 'send') {
    const payload = await sendTelegramMessage(
      parseTelegramSendInput({
        chatId: parsed.chatId,
        text: parsed.text,
        parseMode: parsed.parseMode,
      }),
      options
    );
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const receipt = await handleTelegramUpdate(resolveUpdate(parsed), options);
  console.log(JSON.stringify(receipt, null, 2));
}

async function main(): Promise<void> {
  const argv = await createStandardYargs(process.argv)
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Read a Telegram bridge payload from a JSON file',
    })
    .option('port', { type: 'number', default: Number(process.env.TELEGRAM_BRIDGE_PORT || '3035') })
    .option('token', { type: 'string', description: 'Telegram Bot API token' })
    .option('api-base-url', {
      type: 'string',
      default: process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org',
    })
    .option('parse-mode', {
      type: 'string',
      default: process.env.TELEGRAM_PARSE_MODE || 'Markdown',
    })
    .option('dry-run', {
      type: 'boolean',
      default: process.env.TELEGRAM_DRY_RUN === '1' || !process.env.TELEGRAM_BOT_TOKEN,
    })
    .option('webhook-path', {
      type: 'string',
      default: process.env.TELEGRAM_WEBHOOK_PATH || '/webhook',
    })
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
    logger.warn(
      '⚠️ [TelegramBridge] Running in dry-run mode because TELEGRAM_BOT_TOKEN is not configured.'
    );
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
        const body = (await readTelegramJsonObject(req)) as TelegramUpdate;
        const receipt = await handleTelegramUpdate(body, options);
        sendJson(res, 200, receipt);
        return;
      }
      if (req.method === 'POST' && url === '/send') {
        const body = (await readTelegramJsonObject(req)) as TelegramBridgeInput;
        const payload = await sendTelegramMessage(parseTelegramSendInput(body), options);
        sendJson(res, 200, payload);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error: unknown) {
      logger.error(`❌ [TelegramBridge] Request failed: ${errorDetail(error)}`);
      sendJson(res, 400, {
        ok: false,
        error: errorDetail(error),
      });
    }
  });

  const port = Number(argv.port || process.env.TELEGRAM_BRIDGE_PORT || 3035);
  server.listen(port, '127.0.0.1', () => {
    logger.success(`📨 [TelegramBridge] listening on http://127.0.0.1:${port}`);
  });

  // E2E-04 Task 2: drain the telegram surface outbox (operator notifications
  // enqueued by core, e.g. notifyOperator) — same shape as the Slack bridge.
  const drainOutbox = () =>
    drainSurfaceOutbox(
      'telegram',
      (message) =>
        sendTelegramMessage({ chatId: message.channel, text: message.text }, options).then(
          () => undefined
        ),
      { includeTenantNamespaces: true }
    );
  const runTelegramOutbox = createSurfaceOutboxDrainGuard('telegram');
  setInterval(() => void runTelegramOutbox(drainOutbox), 15_000).unref();
  void runTelegramOutbox(drainOutbox);
}

const directEntry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (directEntry && !process.env.VITEST) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
