import * as path from 'node:path';

import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { 
  createStandardYargs, 
  logger, 
  pathResolver,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  runSurfaceMessageConversation 
} from '@agent/core';

const DISCORD_SURFACE_AGENT_ID = 'discord-surface-agent';
const DISCORD_THREAD_HISTORY_ROOT = 'active/shared/runtime/discord-bridge/thread-history';

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
  return pathResolver.resolve(`${DISCORD_THREAD_HISTORY_ROOT}/${sanitizePathSegment(threadTs)}.jsonl`);
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
  entries: DiscordThreadHistoryEntry[],
): string | undefined {
  const recent = entries
    .filter((entry) => entry.text.trim().length > 0)
    .slice(-6);

  if (!recent.length) return undefined;

  return [
    'Recent Discord thread context:',
    ...recent.map((entry) => (
      entry.role === 'assistant'
        ? `Assistant: ${entry.text}`
        : `User (${entry.authorLabel}): ${entry.text}`
    )),
  ].join('\n');
}

async function collectDiscordThreadContext(message: Message): Promise<string | undefined> {
  const historyEntries: DiscordThreadHistoryEntry[] = [];
  const channel = message.channel as any;

  if (channel?.messages?.fetch) {
    try {
      const fetched = await channel.messages.fetch({ limit: 8, before: message.id });
      for (const entry of (Array.from(fetched.values()) as any[]).sort((a, b) => Number(a?.createdTimestamp || 0) - Number(b?.createdTimestamp || 0))) {
        const content = String(entry?.content || '').trim();
        if (!content) continue;
        historyEntries.push({
          role: entry?.author?.bot ? 'assistant' : 'user',
          authorLabel: String(entry?.author?.tag || entry?.author?.username || entry?.author?.id || 'unknown'),
          text: content,
          messageId: String(entry?.id || ''),
          threadTs: message.channelId,
          channelId: message.channelId,
          receivedAt: entry?.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString(),
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

  logger.info(`📥 [DiscordBridge] Message from ${message.author.tag}: ${message.content}`);
  const threadTs = message.channelId;
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
        'Produce a concise Discord reply. Use markdown if appropriate. Do not use A2A blocks.'
    } as any);

    if (result.text) {
      logger.info(`📤 [DiscordBridge] Replying to ${message.author.tag}`);
      await message.reply(result.text);
      appendDiscordThreadHistory({
        role: 'assistant',
        authorLabel: DISCORD_SURFACE_AGENT_ID,
        text: result.text,
        messageId: `reply-${message.id}`,
        threadTs,
        channelId: message.channelId,
        receivedAt: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    logger.error(`❌ [DiscordBridge] Conversation failed: ${err.message}`);
  }
}

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

  try {
    await client.login(token);
  } catch (err: any) {
    logger.error(`❌ [DiscordBridge] Login failed: ${err.message}`);
    process.exit(1);
  }
}

if (!process.env.VITEST) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
