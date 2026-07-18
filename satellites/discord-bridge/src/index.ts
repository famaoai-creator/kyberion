import * as path from 'node:path';
import { installProcessGuards } from '@agent/core';

import { Client, GatewayIntentBits, Events, Message } from 'discord.js';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('discord-bridge');
import {
  resolveOperatorLocale,
  createStandardYargs,
  logger,
  startBridgeTypingLoop,
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  runSurfaceMessageConversation,
  buildBridgeEmptyReplyText,
  chunkSurfaceMessage,
  postBridgeError,
  listSurfaceOutboxMessages,
  clearSurfaceOutboxMessage,
  createSurfaceOutboxDrainGuard,
  isSurfaceOutboxDue,
  recordSurfaceDeliverySuccess,
  settleSurfaceOutboxFailure,
  resolveMissionProposalReply,
  stashMissionProposalForConfirmation,
  evaluateSurfaceActorAccess,
  sendSurfaceTextWithFallback,
  buildSurfaceApprovalActions,
  buildSurfaceApprovalText,
  createSurfaceApprovalRequest,
  resolveSurfaceApprovalReply,
} from '@agent/core';

const DISCORD_SURFACE_AGENT_ID = 'discord-surface-agent';
const DISCORD_THREAD_HISTORY_ROOT = 'active/shared/runtime/discord-bridge/thread-history';

async function replyDiscordText(message: Message, text: string): Promise<void> {
  for (const chunk of chunkSurfaceMessage(text, 'discord')) {
    await sendSurfaceTextWithFallback({
      surface: 'discord',
      text: chunk,
      send: ({ text: plainOrRichText }) => message.reply(plainOrRichText),
    });
  }
}

async function replyDiscordApproval(
  message: Message,
  text: string,
  record: Awaited<ReturnType<typeof createSurfaceApprovalRequest>>
): Promise<void> {
  const buttons = buildSurfaceApprovalActions(record).map((action) => ({
    type: 2,
    style: action.decision === 'approved' ? 3 : 4,
    label: action.decision === 'approved' ? '承認' : '却下',
    custom_id: action.callbackData,
  }));
  await message.reply({
    content: text,
    components: [{ type: 1, components: buttons }],
  } as any);
}

export interface DiscordThreadHistoryEntry {
  role: 'user' | 'assistant';
  authorLabel: string;
  text: string;
  messageId: string;
  threadTs: string;
  channelId: string;
  receivedAt: string;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveDiscordThreadHistoryPath(threadTs: string): string {
  return pathResolver.resolve(
    `${DISCORD_THREAD_HISTORY_ROOT}/${sanitizePathSegment(threadTs)}.jsonl`
  );
}

function readDiscordThreadHistory(threadTs: string): DiscordThreadHistoryEntry[] {
  const resolved = resolveDiscordThreadHistoryPath(threadTs);
  if (!safeExistsSync(resolved)) return [];
  const raw = String(safeReadFile(resolved, { encoding: 'utf8' }) || '').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as DiscordThreadHistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DiscordThreadHistoryEntry => Boolean(entry));
}

function appendDiscordThreadHistory(entry: DiscordThreadHistoryEntry): void {
  try {
    const resolved = resolveDiscordThreadHistoryPath(entry.threadTs);
    safeMkdir(path.dirname(resolved), { recursive: true });
    safeAppendFileSync(resolved, `${JSON.stringify(entry)}\n`);
  } catch (error: any) {
    logger.warn(`⚠️ [DiscordBridge] Failed to persist thread history: ${error?.message || error}`);
  }
}

export function buildDiscordThreadContextFromEntries(
  entries: DiscordThreadHistoryEntry[]
): string | undefined {
  const recent = entries.filter((entry) => entry.text.trim().length > 0).slice(-6);

  if (!recent.length) return undefined;

  return [
    'Recent Discord thread context:',
    ...recent.map((entry) =>
      entry.role === 'assistant'
        ? `Assistant: ${entry.text}`
        : `User (${entry.authorLabel}): ${entry.text}`
    ),
  ].join('\n');
}

async function collectDiscordThreadContext(message: Message): Promise<string | undefined> {
  const historyEntries: DiscordThreadHistoryEntry[] = [];
  const channel = message.channel as any;

  if (channel?.messages?.fetch) {
    try {
      const fetched = await channel.messages.fetch({ limit: 8, before: message.id });
      for (const entry of (Array.from(fetched.values()) as any[]).sort(
        (a, b) => Number(a?.createdTimestamp || 0) - Number(b?.createdTimestamp || 0)
      )) {
        const content = String(entry?.content || '').trim();
        if (!content) continue;
        historyEntries.push({
          role: entry?.author?.bot ? 'assistant' : 'user',
          authorLabel: String(
            entry?.author?.tag || entry?.author?.username || entry?.author?.id || 'unknown'
          ),
          text: content,
          messageId: String(entry?.id || ''),
          threadTs: message.channelId,
          channelId: message.channelId,
          receivedAt: entry?.createdAt
            ? new Date(entry.createdAt).toISOString()
            : new Date().toISOString(),
        });
      }
    } catch (error: any) {
      logger.warn(`⚠️ [DiscordBridge] Failed to fetch channel history: ${error?.message || error}`);
    }
  }

  if (historyEntries.length > 0) {
    return buildDiscordThreadContextFromEntries(historyEntries);
  }

  return buildDiscordThreadContextFromEntries(readDiscordThreadHistory(message.channelId));
}

async function handleDiscordMessage(message: Message) {
  if (message.author.bot) return;

  const access = evaluateSurfaceActorAccess('discord', message.author.id);
  if (!access.allowed) {
    logger.warn(
      `[DiscordBridge] Ignored unauthorized message from sender: ${message.author.id} (${access.reason})`
    );
    return;
  }

  logger.info(`📥 [DiscordBridge] Message from ${message.author.tag}: ${message.content}`);
  const threadTs = message.channelId;

  const approvalReply = resolveSurfaceApprovalReply({
    surface: 'discord',
    channel: message.channelId,
    threadTs,
    text: message.content,
    decidedBy: message.author.id,
  });
  if (approvalReply.handled) {
    await replyDiscordText(message, approvalReply.reply || '');
    return;
  }

  // SN-01 Phase 2: numbered-choice mission-proposal confirmation, same UX
  // contract as Slack ('1 / 作成する' issues, '2 / やめる' cancels).
  const proposalReply = await resolveMissionProposalReply({
    surface: 'discord',
    channel: message.channelId,
    thread: threadTs,
    text: message.content,
  });
  if (proposalReply.handled) {
    await replyDiscordText(message, proposalReply.reply);
    return;
  }

  const threadContext = await collectDiscordThreadContext(message);
  appendDiscordThreadHistory({
    role: 'user',
    authorLabel: message.author.tag,
    text: message.content,
    messageId: message.id,
    threadTs,
    channelId: message.channelId,
    receivedAt: message.createdAt.toISOString(),
  });

  // UX-02: keep the channel's typing indicator alive while we think.
  const typing = startBridgeTypingLoop(
    'discord-bridge',
    () => (message.channel as { sendTyping?: () => Promise<void> }).sendTyping?.(),
    8000
  );
  try {
    const result = await runSurfaceMessageConversation({
      surface: 'discord',
      text: message.content,
      channel: message.channelId,
      threadTs,
      correlationId: `discord-${message.id}`,
      receivedAt: message.createdAt.toISOString(),
      actorId: message.author.id,
      senderAgentId: 'kyberion:discord-bridge',
      agentId: DISCORD_SURFACE_AGENT_ID,
      threadContext: threadContext || undefined,
      delegationSummaryInstruction:
        'Produce a concise Discord reply. Use markdown if appropriate. Do not use A2A blocks.',
    } as any);

    // SN-01 Phase 2: a mission proposal becomes a pending numbered-choice
    // confirmation instead of a plain reply.
    const missionProposal = result.missionProposals?.[0];
    if (missionProposal) {
      const prompt = stashMissionProposalForConfirmation({
        surface: 'discord',
        channel: message.channelId,
        thread: threadTs,
        proposal: missionProposal,
        sourceText: message.content,
        routingDecision: result.routingDecision,
        fallbackSummary: result.text,
      });
      await replyDiscordText(message, prompt);
      appendDiscordThreadHistory({
        role: 'assistant',
        authorLabel: DISCORD_SURFACE_AGENT_ID,
        text: prompt,
        messageId: `reply-${message.id}`,
        threadTs,
        channelId: message.channelId,
        receivedAt: new Date().toISOString(),
      });
      return;
    }

    if (result.approvalRequests.length > 0) {
      for (const draft of result.approvalRequests) {
        const record = createSurfaceApprovalRequest({
          surface: 'discord',
          channel: message.channelId,
          threadTs,
          correlationId: `discord-${message.id}`,
          requestedBy: DISCORD_SURFACE_AGENT_ID,
          draft,
          sourceText: message.content,
        });
        await replyDiscordApproval(message, buildSurfaceApprovalText('discord', record), record);
      }
      return;
    }

    if (result.text) {
      logger.info(`📤 [DiscordBridge] Replying to ${message.author.tag}`);
      // Discord rejects messages over 2,000 chars — long replies used to
      // throw here and vanish into the catch below (UX-01).
      await replyDiscordText(message, result.text);
      appendDiscordThreadHistory({
        role: 'assistant',
        authorLabel: DISCORD_SURFACE_AGENT_ID,
        text: result.text,
        messageId: `reply-${message.id}`,
        threadTs,
        channelId: message.channelId,
        receivedAt: new Date().toISOString(),
      });
    } else {
      // UX-01: an empty agent reply must not read as silence.
      await replyDiscordText(
        message,
        buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() })
      );
    }
  } catch (err: any) {
    logger.error(`❌ [DiscordBridge] Conversation failed: ${err.message}`);
    // UX-01: surface a vocabulary-based error to the user (rate-limited per channel).
    await postBridgeError({
      conversationKey: `discord:${message.channelId}`,
      err,
      surface: 'discord',
      locale: resolveOperatorLocale(),
      post: (errorText) => replyDiscordText(message, errorText),
    });
  } finally {
    typing.stop();
  }
}

export async function handleDiscordInteraction(interaction: any): Promise<void> {
  if (!interaction?.isButton?.()) return;
  const actorId = String(interaction.user?.id || '');
  const access = evaluateSurfaceActorAccess('discord', actorId);
  if (!access.allowed) {
    await interaction.reply({ content: 'この操作は許可されていません。', ephemeral: true });
    return;
  }
  const channel = String(interaction.channelId || '');
  const approvalReply = resolveSurfaceApprovalReply({
    surface: 'discord',
    channel,
    threadTs: channel,
    text: String(interaction.customId || ''),
    decidedBy: actorId,
  });
  if (!approvalReply.handled) {
    await interaction.reply({ content: '未対応の操作です。', ephemeral: true });
    return;
  }
  await interaction.reply({ content: approvalReply.reply || '', ephemeral: true });
}

async function drainDiscordOutbox(client: Client): Promise<void> {
  for (const message of listSurfaceOutboxMessages('discord')) {
    if (!isSurfaceOutboxDue(message)) continue;
    try {
      const channel = await (client as any).channels.fetch(message.channel);
      if (!channel || typeof channel.send !== 'function') {
        throw Object.assign(new Error('channel_not_found'), { status: 404 });
      }
      await channel.send(message.text);
      recordSurfaceDeliverySuccess('discord', message.channel);
      clearSurfaceOutboxMessage('discord', message.message_id);
    } catch (error) {
      const decision = settleSurfaceOutboxFailure('discord', message, error);
      logger.error(
        `❌ [DiscordBridge] Outbox delivery failed for ${message.message_id}: ${error instanceof Error ? error.message : String(error)} (${decision.failure.kind}${decision.dead_letter ? ', dead-lettered' : `, retry at ${decision.next_attempt_at}`})`
      );
    }
  }
}

const runDiscordOutbox = createSurfaceOutboxDrainGuard('discord');

async function main() {
  const argv = await createStandardYargs()
    .option('token', { type: 'string', description: 'Discord Bot Token' })
    .parseSync();

  const token = argv.token || process.env.DISCORD_TOKEN;

  if (!token) {
    logger.error('❌ [DiscordBridge] DISCORD_TOKEN is required.');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.success(`🚀 [DiscordBridge] Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, handleDiscordMessage);
  client.on(Events.InteractionCreate, handleDiscordInteraction);

  try {
    await client.login(token);
  } catch (err: any) {
    logger.error(`❌ [DiscordBridge] Login failed: ${err.message}`);
    process.exit(1);
  }

  const outboxTimer = setInterval(() => {
    runDiscordOutbox(() => drainDiscordOutbox(client)).catch((error) => {
      logger.error(
        `❌ [DiscordBridge] Outbox poll failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, 15_000);
  outboxTimer.unref?.();
  void runDiscordOutbox(() => drainDiscordOutbox(client));
}

if (!process.env.VITEST) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
