import * as path from 'node:path';
import { installProcessGuards } from '@agent/core/process-guards';
import { isDirectEntry } from '@agent/core/direct-entry';
import {
  appendJsonLine,
  getRegisteredEnvText,
  nowIso,
  readJsonLines,
} from '@agent/core/foundation';
import { resolveOperatorLocale } from '@agent/core/operator-identity';
import { t } from '@agent/core/t';
import { createStandardYargs } from '@agent/core/cli-utils';
import { logger } from '@agent/core/core';
import { startBridgeTypingLoop } from '@agent/core/bridge-typing';
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
  postBridgeError,
  sendSurfaceTextWithFallback,
} from '@agent/core/bridge-error-reply';
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

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Events,
  Message,
} from 'discord.js';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('discord-bridge');
const DISCORD_SURFACE_AGENT_ID = 'discord-surface-agent';
const DISCORD_THREAD_HISTORY_ROOT = 'active/shared/runtime/discord-bridge/thread-history';

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DiscordInteractionLike {
  isButton(): boolean;
  user: { id: string };
  channelId: string | null;
  customId?: string;
  reply?: (options: { content: string; ephemeral?: boolean }) => Promise<unknown> | unknown;
}

function hasSendTyping(value: unknown): value is { sendTyping(): Promise<void> } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { sendTyping?: unknown }).sendTyping === 'function'
  );
}

function isSendableChannel(value: unknown): value is { send(content: string): Promise<unknown> } {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { send?: unknown }).send === 'function'
  );
}

interface DiscordHistoryMessageLike {
  id?: string;
  content?: string;
  createdTimestamp?: number;
  createdAt?: Date;
  author?: { bot?: boolean; tag?: string; username?: string; id?: string };
}

interface DiscordHistoryChannelLike {
  messages: {
    fetch(options: { limit: number; before: string }): Promise<{
      values(): Iterable<DiscordHistoryMessageLike>;
    }>;
  };
}

function hasMessageHistory(value: unknown): value is DiscordHistoryChannelLike {
  if (!value || typeof value !== 'object') return false;
  const messages = (value as { messages?: unknown }).messages;
  return Boolean(
    messages &&
    typeof messages === 'object' &&
    typeof (messages as { fetch?: unknown }).fetch === 'function'
  );
}

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
    style: action.decision === 'approved' ? ButtonStyle.Success : ButtonStyle.Danger,
    label: t(
      action.decision === 'approved'
        ? 'bridge:approval_approve_button'
        : 'bridge:approval_reject_button',
      undefined,
      resolveOperatorLocale()
    ),
    customId: action.callbackData,
  }));
  await message.reply({
    content: text,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((button) =>
          new ButtonBuilder()
            .setStyle(button.style)
            .setLabel(button.label)
            .setCustomId(button.customId)
        )
      ),
    ],
  });
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

export function parseDiscordThreadHistoryEntry(value: unknown): DiscordThreadHistoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : undefined;
  const stringField = (field: string): string | undefined =>
    typeof record[field] === 'string' ? record[field] : undefined;
  const authorLabel = stringField('authorLabel');
  const text = stringField('text');
  const messageId = stringField('messageId');
  const threadTs = stringField('threadTs');
  const channelId = stringField('channelId');
  const receivedAt = stringField('receivedAt');
  if (!role || !authorLabel || !text || !messageId || !threadTs || !channelId || !receivedAt)
    return null;
  return {
    role,
    authorLabel,
    text,
    messageId,
    threadTs,
    channelId,
    receivedAt,
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function resolveDiscordThreadHistoryPath(threadTs: string): string {
  return assertSafeRepositoryPath(
    pathResolver.resolve(`${DISCORD_THREAD_HISTORY_ROOT}/${sanitizePathSegment(threadTs)}.jsonl`),
    { allowMissingLeaf: true }
  );
}

function readDiscordThreadHistory(threadTs: string): DiscordThreadHistoryEntry[] {
  const resolved = resolveDiscordThreadHistoryPath(threadTs);
  if (!safeExistsSync(resolved)) return [];
  if (!safeLstat(resolved).isFile()) {
    throw new Error(`Discord thread history must be an existing regular file: ${threadTs}`);
  }
  return readJsonLines<DiscordThreadHistoryEntry>(resolved, {
    onMalformed: 'skip',
    map: (value) => {
      const entry = parseDiscordThreadHistoryEntry(value);
      if (!entry) throw new Error('invalid Discord thread history entry');
      return entry;
    },
  });
}

function appendDiscordThreadHistory(entry: DiscordThreadHistoryEntry): void {
  try {
    const resolved = resolveDiscordThreadHistoryPath(entry.threadTs);
    safeMkdir(path.dirname(resolved), { recursive: true });
    appendJsonLine(resolved, entry);
  } catch (error: unknown) {
    logger.warn(`⚠️ [DiscordBridge] Failed to persist thread history: ${errorDetail(error)}`);
  }
}

export function buildDiscordThreadContextFromEntries(
  entries: DiscordThreadHistoryEntry[]
): string | undefined {
  return formatChannelThreadContext('Discord', entries);
}

async function collectDiscordThreadContext(
  message: Message,
  priorHistoryEntries: DiscordThreadHistoryEntry[]
): Promise<string | undefined> {
  const historyEntries: DiscordThreadHistoryEntry[] = [];
  const channel = message.channel;

  if (hasMessageHistory(channel)) {
    try {
      const fetched = await channel.messages.fetch({ limit: 8, before: message.id });
      for (const entry of Array.from(fetched.values()).sort(
        (a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)
      )) {
        const content = String(entry.content || '').trim();
        if (!content) continue;
        historyEntries.push({
          role: entry.author?.bot ? 'assistant' : 'user',
          authorLabel: entry.author?.tag || entry.author?.username || entry.author?.id || 'unknown',
          text: content,
          messageId: entry.id || '',
          threadTs: message.channelId,
          channelId: message.channelId,
          receivedAt: entry.createdAt?.toISOString() || nowIso(),
        });
      }
    } catch (error: unknown) {
      logger.warn(`⚠️ [DiscordBridge] Failed to fetch channel history: ${errorDetail(error)}`);
    }
  }

  if (historyEntries.length > 0) {
    return buildDiscordThreadContextFromEntries(historyEntries);
  }

  return buildDiscordThreadContextFromEntries(priorHistoryEntries);
}

export async function handleDiscordMessage(message: Message) {
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

  // m1: read the persisted thread history BEFORE appending this message. The
  // API path already excludes it (`before: message.id`); the fallback path used
  // to re-read after the append and leaked the message into its own context.
  const priorHistoryEntries = readDiscordThreadHistory(message.channelId);
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
  const channelAdapter: ChannelAdapter = {
    channel: 'discord',
    actorId: message.author.id,
    threadContext: () => collectDiscordThreadContext(message, priorHistoryEntries),
    typing: () =>
      startBridgeTypingLoop(
        'discord-bridge',
        () => (hasSendTyping(message.channel) ? message.channel.sendTyping() : Promise.resolve()),
        8000
      ),
    shouldSend: ({ result }) =>
      !result.missionProposals?.length && result.approvalRequests.length === 0,
    send: async ({ text }) => {
      await replyDiscordText(message, text);
      appendDiscordThreadHistory({
        role: 'assistant',
        authorLabel: DISCORD_SURFACE_AGENT_ID,
        text,
        messageId: `reply-${message.id}`,
        threadTs,
        channelId: message.channelId,
        receivedAt: nowIso(),
      });
    },
  };
  try {
    await runChannelTurn(
      channelAdapter,
      { text: message.content, channel: message.channelId, threadTs },
      ({ threadContext }) =>
        runSurfaceMessageConversation({
          surface: 'discord',
          text: message.content,
          channel: message.channelId,
          threadTs,
          correlationId: `discord-${message.id}`,
          receivedAt: message.createdAt.toISOString(),
          actorId: message.author.id,
          senderAgentId: 'kyberion:discord-bridge',
          agentId: DISCORD_SURFACE_AGENT_ID,
          threadContext,
          delegationSummaryInstruction:
            'Produce a concise Discord reply. Use markdown if appropriate. Do not use A2A blocks.',
        }),
      {
        // UX-02: typing must stay alive until the proposal/approval
        // envelopes this bridge posts itself have landed.
        afterTurn: async (result) => {
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
              intentResolution: result.intentResolution,
            });
            await replyDiscordText(message, prompt);
            appendDiscordThreadHistory({
              role: 'assistant',
              authorLabel: DISCORD_SURFACE_AGENT_ID,
              text: prompt,
              messageId: `reply-${message.id}`,
              threadTs,
              channelId: message.channelId,
              receivedAt: nowIso(),
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
              await replyDiscordApproval(
                message,
                buildSurfaceApprovalText('discord', record, result.intentResolution),
                record
              );
            }
            return;
          }

          // UX-01: an empty agent reply must not read as silence. Trim first so a
          // whitespace-only reply matches the shared channel-adapter delivery gate.
          if (!result.text.trim()) {
            await replyDiscordText(
              message,
              buildBridgeEmptyReplyText({ locale: resolveOperatorLocale() })
            );
          }
        },
      }
    );
  } catch (err: unknown) {
    logger.error(`❌ [DiscordBridge] Conversation failed: ${errorDetail(err)}`);
    // UX-01: surface a vocabulary-based error to the user (rate-limited per channel).
    await postBridgeError({
      conversationKey: `discord:${message.channelId}`,
      err,
      surface: 'discord',
      locale: resolveOperatorLocale(),
      post: (errorText) => replyDiscordText(message, errorText),
    });
  }
}

export async function handleDiscordInteraction(interaction: DiscordInteractionLike): Promise<void> {
  if (!interaction.isButton() || !interaction.reply) return;
  const actorId = interaction.user.id;
  const access = evaluateSurfaceActorAccess('discord', actorId);
  if (!access.allowed) {
    await interaction.reply({ content: 'この操作は許可されていません。', ephemeral: true });
    return;
  }
  const channel = interaction.channelId || '';
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
  await drainSurfaceOutbox(
    'discord',
    async (message) => {
      const channel = await client.channels.fetch(message.channel);
      if (!isSendableChannel(channel)) {
        throw Object.assign(new Error('channel_not_found'), { status: 404 });
      }
      await channel.send(message.text);
    },
    { includeTenantNamespaces: true }
  );
}

const runDiscordOutbox = createSurfaceOutboxDrainGuard('discord');

async function main() {
  const argv = await createStandardYargs(process.argv)
    .option('token', { type: 'string', description: 'Discord Bot Token' })
    .parseSync();

  const token = argv.token || getRegisteredEnvText('DISCORD_TOKEN');

  if (!token) {
    logger.error('❌ [DiscordBridge] DISCORD_TOKEN is required.');
    process.exitCode = 1;
    return;
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
  } catch (err: unknown) {
    logger.error(`❌ [DiscordBridge] Login failed: ${errorDetail(err)}`);
    process.exitCode = 1;
    return;
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

// Same guard as the Slack/Telegram bridges: only a direct `node index.js`
// invocation starts the bridge, so importing this module in a test cannot open
// a gateway connection — and a leaked VITEST env cannot silently no-op a real
// start.
const directEntry = isDirectEntry(import.meta.url, 'satellites/discord-bridge/src/index.ts');
if (directEntry && !getRegisteredEnvText('VITEST')) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (directEntry) {
  logger.warn('[DiscordBridge] VITEST is set — suppressing the direct-entry start.');
}
