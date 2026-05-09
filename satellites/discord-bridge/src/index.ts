import { Client, GatewayIntentBits, Events, Message } from 'discord.js';
import { 
  createStandardYargs, 
  logger, 
  runSurfaceMessageConversation 
} from '@agent/core';

const DISCORD_SURFACE_AGENT_ID = 'discord-surface-agent';

async function handleDiscordMessage(message: Message) {
  if (message.author.bot) return;

  logger.info(`📥 [DiscordBridge] Message from ${message.author.tag}: ${message.content}`);

  try {
    const result = await runSurfaceMessageConversation({
      surface: 'discord',
      text: message.content,
      channel: message.channelId,
      threadTs: message.id,
      correlationId: `discord-${message.id}`,
      receivedAt: message.createdAt.toISOString(),
      actorId: message.author.id,
      senderAgentId: 'kyberion:discord-bridge',
      agentId: DISCORD_SURFACE_AGENT_ID,
      delegationSummaryInstruction: 
        'Produce a concise Discord reply. Use markdown if appropriate. Do not use A2A blocks.'
    } as any);

    if (result.text) {
      logger.info(`📤 [DiscordBridge] Replying to ${message.author.tag}`);
      await message.reply(result.text);
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

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
