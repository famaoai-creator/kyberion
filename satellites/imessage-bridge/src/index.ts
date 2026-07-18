import express from 'express';
import { installProcessGuards } from '@agent/core';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('imessage-bridge');
import {
  resolveOperatorLocale,
  scheduleBridgeProcessingNote,
  createStandardYargs,
  logger,
  pathResolver,
  safeReadFile,
  describeIMessageBridgeHealth,
  downloadBlueBubblesAttachment,
  parseBlueBubblesWebhook,
  resolveBlueBubblesConfig,
  sendBlueBubblesAttachment,
  sendBlueBubblesText,
  sendIMessage,
  buildIMessageReplyRequest,
  listSurfaceOutboxMessages,
  clearSurfaceOutboxMessage,
  createSurfaceOutboxDrainGuard,
  isSurfaceOutboxDue,
  recordSurfaceDeliverySuccess,
  settleSurfaceOutboxFailure,
  getRecentIMessages,
  getIMessageHistory,
  formatIMessageAttachmentSummary,
  formatIMessageTapbackSummary,
  chunkSurfaceMessage,
  shouldProcessIMessage,
  stripLeadingIMessageWakeWord,
  runSurfaceMessageConversation,
  buildBridgeEmptyReplyText,
  postBridgeError,
  resolveMissionProposalReply,
  stashMissionProposalForConfirmation,
  buildSurfaceApprovalText,
  createSurfaceApprovalRequest,
  resolveSurfaceApprovalReply,
  evaluateSurfaceActorAccess,
  verifyBlueBubblesWebhookSecret,
  advanceIMessagePollCursor,
  type IMessageSendRequest,
  type IMessageProcessingResult,
  type IMessageStimulus,
} from '@agent/core';

interface BridgeInput {
  action?: string;
  recipient?: string;
  text?: string;
  serviceName?: string;
  attachments?: string[];
}

const IMESSAGE_SURFACE_AGENT_ID = 'imessage-surface-agent';
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

function parseInputFile(inputPath: string): BridgeInput {
  const resolved = pathResolver.rootResolve(inputPath);
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as BridgeInput;
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
  for (const message of listSurfaceOutboxMessages('imessage')) {
    if (!isSurfaceOutboxDue(message)) continue;
    try {
      // Surface outbox channels are iMessage chat identifiers. Preserve the
      // chat target so a group completion never becomes a sender DM.
      await sendIMessageText({ recipient: '', chatId: message.channel, text: message.text });
      recordSurfaceDeliverySuccess('imessage', message.channel);
      clearSurfaceOutboxMessage('imessage', message.message_id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const decision = settleSurfaceOutboxFailure('imessage', message, error);
      logger.error(
        `❌ [iMessageBridge] Outbox delivery failed for ${message.message_id}: ${detail} (${decision.failure.kind}${decision.dead_letter ? ', dead-lettered' : `, retry at ${decision.next_attempt_at}`})`
      );
    }
  }
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

  return [
    'Recent iMessage thread context:',
    ...history.map((entry) => {
      const attachmentText = formatIMessageAttachmentSummary(entry.attachments);
      return `${entry.isFromMe ? 'Assistant' : `User (${entry.sender})`}: ${[entry.text, attachmentText].filter(Boolean).join('\n')}`;
    }),
    '',
    `Current incoming message: ${[message.text, formatIMessageAttachmentSummary(message.attachments)].filter(Boolean).join('\n')}`,
  ].join('\n');
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

  const threadContext = buildThreadContext({
    ...msg,
    text: stripLeadingIMessageWakeWord(msg.text),
  });

  // UX-02: iMessage has no typing API — send a one-time working note
  // only if processing outlives 5s (quick replies stay clean).
  const processingNote = scheduleBridgeProcessingNote('imessage-bridge', () =>
    sendIMessageText(buildIMessageReplyRequest(msg, '処理中です。少々お待ちください…'))
  );
  try {
    const conversation = await runSurfaceMessageConversation({
      surface: 'imessage',
      text: incomingText,
      channel: msg.chatId,
      threadTs: msg.id,
      correlationId: `imsg-${msg.id}`,
      receivedAt: msg.date,
      actorId: msg.sender,
      senderAgentId: 'kyberion:imessage-bridge',
      agentId: IMESSAGE_SURFACE_AGENT_ID,
      threadContext: threadContext || undefined,
      attachments: msg.attachments,
      delegationSummaryInstruction:
        'Produce a concise iMessage reply in the user language. Do not use A2A blocks.',
    } as any);

    // SN-01 Phase 2: a mission proposal becomes a pending numbered-choice
    // confirmation instead of a plain reply.
    const missionProposal = conversation.missionProposals?.[0];
    if (missionProposal) {
      const prompt = stashMissionProposalForConfirmation({
        surface: 'imessage',
        channel: msg.chatId,
        thread: msg.chatId,
        proposal: missionProposal,
        sourceText: incomingText,
        routingDecision: conversation.routingDecision,
        fallbackSummary: conversation.text,
      });
      await sendIMessageText(buildIMessageReplyRequest(msg, prompt));
      return 'processed';
    }

    if (conversation.approvalRequests.length > 0) {
      const approvalTexts = conversation.approvalRequests.map((draft) => {
        const record = createSurfaceApprovalRequest({
          surface: 'imessage',
          channel: msg.chatId,
          threadTs: msg.chatId,
          correlationId: `imsg-${msg.id}`,
          requestedBy: IMESSAGE_SURFACE_AGENT_ID,
          draft,
          sourceText: incomingText,
        });
        return buildSurfaceApprovalText('imessage', record);
      });
      await sendIMessageText(buildIMessageReplyRequest(msg, approvalTexts.join('\n\n')));
      return 'processed';
    }

    if (conversation.text) {
      logger.info(`📤 [iMessageBridge] Replying to ${msg.sender}: ${conversation.text}`);
      await sendIMessageText(buildIMessageReplyRequest(msg, conversation.text));
    } else {
      // UX-01: an empty agent reply must not read as silence.
      await sendIMessageText(
        buildIMessageReplyRequest(
          msg,
          buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() })
        )
      );
    }
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
  } finally {
    processingNote.cancel();
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
  } catch (err: any) {
    logger.error(`❌ [iMessageBridge] Poll failed: ${err.message}`);
  }
}

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string' })
    .option('port', { type: 'number', default: Number(process.env.IMESSAGE_BRIDGE_PORT || '3034') })
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
      const body = (req.body || {}) as BridgeInput;
      const result = await handleSend({
        recipient: String(body.recipient || ''),
        text: String(body.text || ''),
        serviceName: body.serviceName,
        attachments: body.attachments,
      });
      res.json({ ok: true, result });
    } catch (error: any) {
      res.status(400).json({
        ok: false,
        error: error?.message || String(error),
      });
    }
  });

  const port = Number(argv.port || process.env.IMESSAGE_BRIDGE_PORT || 3034);
  app.listen(port, '127.0.0.1', () => {
    logger.success(`📨 [iMessageBridge] listening on http://127.0.0.1:${port}`);
  });
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
