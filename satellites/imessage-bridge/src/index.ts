import express from 'express';
import { installProcessGuards } from '@agent/core/process-guards';
import { isDirectEntry } from '@agent/core/direct-entry';
import { getRegisteredEnvText, readJson } from '@agent/core/foundation';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { t } from '@agent/core/t';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import * as pathResolver from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import {
  formatChannelThreadContext,
  runChannelTurn,
  type ChannelAdapter,
} from '@agent/core/channel-adapter';
import {
  chunkSurfaceMessage,
  buildBridgeEmptyReplyText,
  postBridgeError,
} from '@agent/core/bridge-error-reply';
import { createSurfaceOutboxDrainGuard, drainSurfaceOutbox } from '@agent/core/surface-delivery';
import {
  resolveMissionProposalReply,
  stashMissionProposalForConfirmation,
} from '@agent/core/surface-mission-proposals';
import {
  buildSurfaceApprovalText,
  createSurfaceApprovalRequest,
  resolveSurfaceApprovalReply,
  runSurfaceMessageConversation,
} from '@agent/core/channel-surface';
import { evaluateSurfaceActorAccess } from '@agent/core/surface-access-policy';
import {
  describeIMessageBridgeHealth,
  sendIMessage,
  buildIMessageReplyRequest,
  advanceIMessagePollCursor,
  type IMessageSendRequest,
  type IMessageProcessingResult,
} from '@agent/core/imessage-bridge';
import {
  getRecentIMessages,
  getIMessageHistory,
  formatIMessageAttachmentSummary,
  formatIMessageTapbackSummary,
  shouldProcessIMessage,
  stripLeadingIMessageWakeWord,
  type IMessageStimulus,
} from '@agent/core/imessage-utils';
import {
  downloadBlueBubblesAttachment,
  parseBlueBubblesWebhook,
  resolveBlueBubblesConfig,
  sendBlueBubblesAttachment,
  sendBlueBubblesText,
  verifyBlueBubblesWebhookSecret,
} from '@agent/core/bluebubbles-adapter';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('imessage-bridge');
import { scheduleBridgeProcessingNote } from '@agent/core/bridge-typing';

interface BridgeInput {
  action?: string;
  recipient?: string;
  text?: string;
  serviceName?: string;
  attachments?: string[];
}

const IMESSAGE_SURFACE_AGENT_ID = 'imessage-surface-agent';

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const MAX_IMESSAGE_ATTACHMENTS = 8;
let lastSeenRowId = 0;

async function sendIMessageText(request: IMessageSendRequest) {
  const chunks = request.text.trim() ? chunkSurfaceMessage(request.text, 'imessage') : [''];
  const blueBubbles = resolveBlueBubblesConfig();
  if (blueBubbles) {
    const chatGuid = String(request.chatId || request.recipient || '').trim();
    if (!chatGuid) throw new Error('BlueBubbles sending requires a chatId or recipient chat GUID');
    const attachments = request.attachments || [];
    if (attachments.length > MAX_IMESSAGE_ATTACHMENTS) {
      throw new Error(`too many attachments (max ${MAX_IMESSAGE_ATTACHMENTS})`);
    }
    if (attachments.length > 0) {
      let lastResult;
      for (const [index, filePath] of attachments.entries()) {
        lastResult = await sendBlueBubblesAttachment(blueBubbles, {
          chatGuid,
          filePath,
          message: index === 0 ? request.text : undefined,
        });
      }
      return lastResult!;
    }
    let lastResult;
    for (const chunk of chunks) {
      lastResult = await sendBlueBubblesText(blueBubbles, {
        chatGuid,
        text: chunk,
      });
    }
    return lastResult!;
  }
  let lastResult;
  for (const [index, chunk] of chunks.entries()) {
    lastResult = sendIMessage({
      ...request,
      text: chunk,
      // Attach once; sending the same binary payload for every text chunk
      // would duplicate the file in Messages.
      attachments: index === 0 ? request.attachments : undefined,
    });
  }
  return lastResult!;
}

function isDarwin(): boolean {
  return process.platform === 'darwin';
}

export function parseIMessageBridgeInput(value: unknown): BridgeInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  for (const field of ['action', 'recipient', 'text', 'serviceName']) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      throw new Error(`${field} must be a string`);
    }
  }
  if (
    record.attachments !== undefined &&
    (!Array.isArray(record.attachments) ||
      record.attachments.some((attachment) => typeof attachment !== 'string'))
  ) {
    throw new Error('attachments must be an array of strings');
  }
  return {
    ...(typeof record.action === 'string' ? { action: record.action } : {}),
    ...(typeof record.recipient === 'string' ? { recipient: record.recipient } : {}),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.serviceName === 'string' ? { serviceName: record.serviceName } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: record.attachments as string[] } : {}),
  };
}

export function resolveIMessageBridgeInputPath(inputPath: string): string {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(inputPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(resolved) || !safeLstat(resolved).isFile()) {
    throw new Error(`iMessage bridge input must be an existing regular file: ${inputPath}`);
  }
  return resolved;
}

function parseInputFile(inputPath: string): BridgeInput {
  const resolved = resolveIMessageBridgeInputPath(inputPath);
  return parseIMessageBridgeInput(readJson<unknown>(resolved));
}

async function handleSend(request: IMessageSendRequest) {
  return sendIMessageText(request);
}

async function hydrateBlueBubblesAttachments(
  message: IMessageStimulus,
  config: NonNullable<ReturnType<typeof resolveBlueBubblesConfig>>
): Promise<IMessageStimulus> {
  if (!message.attachments?.length) return message;
  const attachments = [];
  for (const attachment of message.attachments) {
    if (!attachment.id || attachment.id.startsWith('attachment-')) {
      attachments.push(attachment);
      continue;
    }
    const downloaded = await downloadBlueBubblesAttachment(config, {
      attachmentGuid: attachment.id,
      storageKey: message.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    });
    attachments.push({
      ...attachment,
      path: downloaded.filePath,
      filename: downloaded.filename,
      mimeType: downloaded.mimeType || attachment.mimeType,
      size: downloaded.size,
    });
  }
  return { ...message, attachments };
}

async function drainIMessageOutbox(): Promise<void> {
  await drainSurfaceOutbox(
    'imessage',
    async (message) => {
      // Surface outbox channels are iMessage chat identifiers. Preserve the
      // chat target so a group completion never becomes a sender DM.
      await sendIMessageText({ recipient: '', chatId: message.channel, text: message.text });
    },
    { includeTenantNamespaces: true }
  );
}

const runIMessageOutbox = createSurfaceOutboxDrainGuard('imessage');

function buildThreadContext(message: {
  id: string;
  chatId: string;
  sender: string;
  text: string;
  attachments?: {
    id: string;
    filename?: string;
    mimeType?: string;
    uti?: string;
    path?: string;
    size?: number;
  }[];
}): string {
  const currentId = Number(message.id);
  if (!Number.isFinite(currentId)) return '';
  const history = getIMessageHistory(message.chatId, 8)
    .filter((entry) => Number(entry.id) < currentId)
    .slice(-6);
  if (history.length === 0) return '';

  // The shared surface runtime appends the current incoming message after
  // threadContext. Keep this provider formatter limited to prior turns so
  // iMessage cannot submit the current message twice.
  return (
    formatChannelThreadContext(
      'iMessage',
      history.map((entry) => ({
        role: entry.isFromMe ? ('assistant' as const) : ('user' as const),
        authorLabel: entry.sender,
        text: [entry.text, formatIMessageAttachmentSummary(entry.attachments)]
          .filter(Boolean)
          .join('\n'),
      })),
      resolveOperatorLocale()
    ) || ''
  );
}

function buildIncomingIMessageText(message: {
  text: string;
  attachments?: {
    id: string;
    filename?: string;
    mimeType?: string;
    uti?: string;
    path?: string;
    size?: number;
  }[];
}): string {
  return [
    stripLeadingIMessageWakeWord(message.text),
    formatIMessageAttachmentSummary(message.attachments),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * M3g-ii: arm the "working" note inside `typing.start`, never before the turn.
 * runChannelTurn resolves thread context first and stops typing in `finally`,
 * so a thread-context failure now leaves no timer behind — the note can no
 * longer fire for a turn that already failed.
 */
export function buildIMessageChannelAdapter(msg: IMessageStimulus): ChannelAdapter {
  return {
    channel: 'imessage',
    actorId: msg.sender,
    threadContext: () =>
      buildThreadContext({
        ...msg,
        text: stripLeadingIMessageWakeWord(msg.text),
      }) || undefined,
    // UX-02: iMessage has no typing API — send a one-time working note
    // only if processing outlives 5s (quick replies stay clean).
    typing: () => {
      const processingNote = scheduleBridgeProcessingNote('imessage-bridge', () =>
        sendIMessageText(
          buildIMessageReplyRequest(
            msg,
            t('bridge:processing_note', undefined, resolveOperatorLocale())
          )
        )
      );
      return { stop: () => processingNote.cancel() };
    },
    shouldSend: ({ result }) =>
      !result.missionProposals?.length && result.approvalRequests.length === 0,
    send: async ({ text }) => {
      await sendIMessageText(buildIMessageReplyRequest(msg, text));
    },
  };
}

const processedMessageKeys = new Set<string>();

async function processIncomingIMessage(msg: IMessageStimulus): Promise<IMessageProcessingResult> {
  const key = `${msg.chatGuid || msg.chatId}:${msg.id}`;
  if (processedMessageKeys.has(key)) return 'duplicate';
  processedMessageKeys.add(key);
  if (processedMessageKeys.size > 2000) {
    const oldest = processedMessageKeys.values().next().value;
    if (oldest) processedMessageKeys.delete(oldest);
  }
  const releaseDedupKey = () => processedMessageKeys.delete(key);
  const sendReply = async (text: string): Promise<boolean> => {
    try {
      await sendIMessageText(buildIMessageReplyRequest(msg, text));
      return true;
    } catch (error) {
      releaseDedupKey();
      logger.error(
        `❌ [iMessageBridge] Reply delivery failed for ${msg.sender}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  };

  if (msg.isFromMe) return 'ignored';

  const access = evaluateSurfaceActorAccess('imessage', msg.sender);
  if (!access.allowed) {
    logger.info(
      `⏭️ [iMessageBridge] Ignoring unauthorized sender ${msg.sender} (${access.reason})`
    );
    return 'ignored';
  }

  logger.info(`📥 [iMessageBridge] Message from ${msg.sender}: ${msg.text}`);
  if (msg.tapback) {
    logger.info(
      `⏭️ [iMessageBridge] Ignoring tapback without starting a model turn: ${formatIMessageTapbackSummary(msg.tapback)}`
    );
    return 'ignored';
  }
  if (!shouldProcessIMessage(msg)) {
    logger.info(`⏭️ [iMessageBridge] Ignoring group message without wake word in ${msg.chatId}`);
    return 'ignored';
  }
  const incomingText = buildIncomingIMessageText(msg);

  let approvalReply;
  try {
    approvalReply = resolveSurfaceApprovalReply({
      surface: 'imessage',
      channel: msg.chatId,
      threadTs: msg.chatId,
      text: incomingText,
      decidedBy: msg.sender,
    });
  } catch (error) {
    releaseDedupKey();
    logger.error(
      `❌ [iMessageBridge] Approval reply resolution failed for ${msg.sender}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 'failed';
  }
  if (approvalReply.handled) {
    return (await sendReply(approvalReply.reply || '')) ? 'processed' : 'failed';
  }

  // SN-01 Phase 2: numbered-choice mission-proposal confirmation. The
  // pending-state key uses chatId for BOTH channel and thread — row ids
  // change per adapter, so they cannot key a pending proposal.
  let proposalReply;
  try {
    proposalReply = await resolveMissionProposalReply({
      surface: 'imessage',
      channel: msg.chatId,
      thread: msg.chatId,
      text: incomingText,
    });
  } catch (error) {
    releaseDedupKey();
    logger.error(
      `❌ [iMessageBridge] Mission proposal resolution failed for ${msg.sender}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 'failed';
  }
  if (proposalReply.handled) {
    return (await sendReply(proposalReply.reply)) ? 'processed' : 'failed';
  }

  const channelAdapter = buildIMessageChannelAdapter(msg);
  try {
    await runChannelTurn(
      channelAdapter,
      {
        text: incomingText,
        channel: msg.chatId,
        threadTs: msg.id,
        locale: resolveOperatorLocale(),
        attachments: msg.attachments,
      },
      ({ threadContext }) =>
        runSurfaceMessageConversation({
          surface: 'imessage',
          locale: resolveOperatorLocale(),
          text: incomingText,
          channel: msg.chatId,
          threadTs: msg.id,
          correlationId: `imsg-${msg.id}`,
          receivedAt: msg.date,
          actorId: msg.sender,
          attachments: msg.attachments,
          senderAgentId: 'kyberion:imessage-bridge',
          agentId: IMESSAGE_SURFACE_AGENT_ID,
          threadContext,
          delegationSummaryInstruction:
            'Produce a concise iMessage reply in the user language. Do not use A2A blocks.',
        }),
      {
        // UX-02: the processing note must stay armed until the proposal and
        // approval envelopes this bridge posts itself have landed.
        afterTurn: async (result) => {
          // SN-01 Phase 2: a mission proposal becomes a pending numbered-choice
          // confirmation instead of a plain reply.
          const missionProposal = result.missionProposals?.[0];
          if (missionProposal) {
            const prompt = stashMissionProposalForConfirmation({
              surface: 'imessage',
              channel: msg.chatId,
              thread: msg.chatId,
              proposal: missionProposal,
              sourceText: incomingText,
              routingDecision: result.routingDecision,
              fallbackSummary: result.text,
              intentResolution: result.intentResolution,
            });
            await sendIMessageText(buildIMessageReplyRequest(msg, prompt));
            return;
          }

          if (result.approvalRequests.length > 0) {
            const approvalTexts = result.approvalRequests.map((draft) => {
              const record = createSurfaceApprovalRequest({
                surface: 'imessage',
                channel: msg.chatId,
                threadTs: msg.chatId,
                correlationId: `imsg-${msg.id}`,
                requestedBy: IMESSAGE_SURFACE_AGENT_ID,
                draft,
                sourceText: incomingText,
              });
              return buildSurfaceApprovalText('imessage', record, result.intentResolution);
            });
            await sendIMessageText(buildIMessageReplyRequest(msg, approvalTexts.join('\n\n')));
            return;
          }

          // UX-01: an empty agent reply must not read as silence. Trim first so a
          // whitespace-only reply matches the shared channel-adapter delivery gate.
          if (!result.text.trim()) {
            await sendIMessageText(
              buildIMessageReplyRequest(
                msg,
                buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() })
              )
            );
          }
        },
      }
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`❌ [iMessageBridge] Conversation failed for ${msg.sender}: ${detail}`);
    // UX-01: surface a vocabulary-based error to the user (rate-limited per chat).
    try {
      await postBridgeError({
        conversationKey: `imessage:${msg.chatId}`,
        err,
        surface: 'imessage',
        locale: resolveOperatorLocale(),
        post: async (errorText) => sendIMessageText(buildIMessageReplyRequest(msg, errorText)),
      });
    } catch (postError) {
      logger.error(
        `❌ [iMessageBridge] Failed to post conversation error for ${msg.sender}: ${
          postError instanceof Error ? postError.message : String(postError)
        }`
      );
    } finally {
      // A failed turn must be retryable. Do not let a failed error reply leave
      // the original webhook permanently suppressed by the dedup set.
      releaseDedupKey();
    }
    return 'failed';
  }
  return 'processed';
}

async function pollIMessages() {
  try {
    const newMessages = getRecentIMessages(lastSeenRowId);
    for (const msg of newMessages) {
      const msgId = Number(msg.id);
      if (!Number.isFinite(msgId) || msgId <= lastSeenRowId) continue;
      const result = await processIncomingIMessage(msg);
      const nextCursor = advanceIMessagePollCursor(lastSeenRowId, msgId, result);
      if (nextCursor === lastSeenRowId && result === 'failed') break;
      lastSeenRowId = nextCursor;
    }
  } catch (err: unknown) {
    logger.error(`❌ [iMessageBridge] Poll failed: ${errorDetail(err)}`);
  }
}

async function main() {
  const argv = await createStandardYargs(process.argv)
    .option('input', { alias: 'i', type: 'string' })
    .option('port', {
      type: 'number',
      default: Number(getRegisteredEnvText('IMESSAGE_BRIDGE_PORT') || '3034'),
    })
    .option('poll', {
      type: 'boolean',
      default: true,
      description: 'Enable background message polling',
    })
    .parseSync();

  if (argv.input) {
    const input = parseInputFile(argv.input as string);
    if ((input.action || 'send') !== 'send') {
      throw new Error(`Unsupported action: ${input.action}`);
    }
    const result = await handleSend({
      recipient: String(input.recipient || ''),
      text: String(input.text || ''),
      serviceName: input.serviceName,
      attachments: input.attachments,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!isDarwin()) {
    logger.warn(
      'iMessage bridge is macOS-only. Health endpoints remain available, but send operations will fail until launched on Darwin.'
    );
  }

  if (isDarwin()) {
    const existing = getRecentIMessages(0);
    if (existing.length > 0) {
      lastSeenRowId = Math.max(...existing.map((m) => Number(m.id)));
      logger.info(`🚀 [iMessageBridge] Initialized. Last message ID: ${lastSeenRowId}`);
    }

    if (argv.poll) {
      logger.info('🔍 [iMessageBridge] Starting background polling (every 5s)...');
      setInterval(pollIMessages, 5000).unref();
    }

    // HA-07: drain mission/operator notifications queued for the iMessage
    // surface. Keep failed records for a later retry instead of dropping them.
    setInterval(() => void runIMessageOutbox(drainIMessageOutbox), 15_000).unref();
    void runIMessageOutbox(drainIMessageOutbox);
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'imessage-bridge',
      ...describeIMessageBridgeHealth(),
    });
  });

  app.post('/webhooks/bluebubbles', async (req, res) => {
    const config = resolveBlueBubblesConfig();
    if (!config) {
      res.status(503).json({ ok: false, error: 'bluebubbles_not_configured' });
      return;
    }
    if (!config.webhookSecret) {
      res.status(503).json({ ok: false, error: 'bluebubbles_webhook_secret_not_configured' });
      return;
    }
    const authorization = String(req.get('authorization') || '');
    const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1];
    const providedSecret = req.get('x-kyberion-bluebubbles-secret') || bearer;
    if (!verifyBlueBubblesWebhookSecret(config.webhookSecret, providedSecret)) {
      res.status(401).json({ ok: false, error: 'invalid_webhook_secret' });
      return;
    }
    const message = parseBlueBubblesWebhook(req.body);
    if (!message) {
      res.status(202).json({ ok: true, accepted: false, reason: 'ignored_event' });
      return;
    }
    try {
      const hydratedMessage = await hydrateBlueBubblesAttachments(message, config);
      const result = await processIncomingIMessage(hydratedMessage);
      if (result === 'failed') {
        res.status(500).json({ ok: false, error: 'webhook_processing_failed' });
        return;
      }
      res.status(202).json({ ok: true, accepted: true, result });
    } catch (error) {
      logger.error(
        `❌ [iMessageBridge] BlueBubbles webhook processing failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      res.status(500).json({ ok: false, error: 'webhook_processing_failed' });
    }
  });

  app.post('/send', async (req, res) => {
    try {
      const body = parseIMessageBridgeInput(req.body || {});
      const result = await handleSend({
        recipient: body.recipient || '',
        text: body.text || '',
        serviceName: body.serviceName,
        attachments: body.attachments,
      });
      res.json({ ok: true, result });
    } catch (error: unknown) {
      res.status(400).json({
        ok: false,
        error: errorDetail(error),
      });
    }
  });

  const port = Number(argv.port || getRegisteredEnvText('IMESSAGE_BRIDGE_PORT') || 3034);
  app.listen(port, '127.0.0.1', () => {
    logger.success(`📨 [iMessageBridge] listening on http://127.0.0.1:${port}`);
  });
}

// Same guard as the Telegram bridge: only a direct `node index.js` invocation
// starts the bridge, so importing this module in a test cannot start the HTTP
// listener or the poll loop — and a leaked VITEST env cannot silently no-op a
// real start.
const directEntry = isDirectEntry(import.meta.url, 'satellites/imessage-bridge/src/index.ts');
if (directEntry && !getRegisteredEnvText('VITEST')) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (directEntry) {
  logger.warn('[iMessageBridge] VITEST is set — suppressing the direct-entry start.');
}
