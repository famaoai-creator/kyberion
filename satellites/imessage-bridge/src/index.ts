import express from 'express';
import { 
  createStandardYargs, 
  logger, 
  pathResolver, 
  safeReadFile,
  describeIMessageBridgeHealth, 
  sendIMessage, 
  getRecentIMessages,
  runSurfaceMessageConversation,
  type IMessageSendRequest 
} from '@agent/core';

interface BridgeInput {
  action?: string;
  recipient?: string;
  text?: string;
  serviceName?: string;
}

const IMESSAGE_SURFACE_AGENT_ID = 'imessage-surface-agent';
let lastSeenRowId = 0;

function isDarwin(): boolean {
  return process.platform === 'darwin';
}

function parseInputFile(inputPath: string): BridgeInput {
  const resolved = pathResolver.rootResolve(inputPath);
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as BridgeInput;
}

async function handleSend(request: IMessageSendRequest) {
  return sendIMessage(request);
}

async function pollIMessages() {
  try {
    const newMessages = getRecentIMessages(lastSeenRowId);
    for (const msg of newMessages) {
      lastSeenRowId = Math.max(lastSeenRowId, Number(msg.id));
      
      if (msg.isFromMe) continue;

      logger.info(`📥 [iMessageBridge] Message from ${msg.sender}: ${msg.text}`);

      const conversation = await runSurfaceMessageConversation({
        surface: 'imessage',
        text: msg.text,
        channel: msg.chatId,
        threadTs: msg.id,
        correlationId: `imsg-${msg.id}`,
        receivedAt: msg.date,
        actorId: msg.sender,
        senderAgentId: 'kyberion:imessage-bridge',
        agentId: IMESSAGE_SURFACE_AGENT_ID,
        delegationSummaryInstruction: 
          'Produce a concise iMessage reply in the user language. Do not use A2A blocks.'
      } as any);

      if (conversation.text) {
        logger.info(`📤 [iMessageBridge] Replying to ${msg.sender}: ${conversation.text}`);
        await sendIMessage({
          recipient: msg.sender,
          text: conversation.text
        });
      }
    }
  } catch (err: any) {
    logger.error(`❌ [iMessageBridge] Poll failed: ${err.message}`);
  }
}

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string' })
    .option('port', { type: 'number', default: Number(process.env.IMESSAGE_BRIDGE_PORT || '3034') })
    .option('poll', { type: 'boolean', default: true, description: 'Enable background message polling' })
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
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!isDarwin()) {
    logger.warn('iMessage bridge is macOS-only. Health endpoints remain available, but send operations will fail until launched on Darwin.');
  }

  if (isDarwin()) {
    const existing = getRecentIMessages(0);
    if (existing.length > 0) {
      lastSeenRowId = Math.max(...existing.map(m => Number(m.id)));
      logger.info(`🚀 [iMessageBridge] Initialized. Last message ID: ${lastSeenRowId}`);
    }

    if (argv.poll) {
      logger.info('🔍 [iMessageBridge] Starting background polling (every 5s)...');
      setInterval(pollIMessages, 5000).unref();
    }
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

  app.post('/send', async (req, res) => {
    try {
      const body = (req.body || {}) as BridgeInput;
      const result = await handleSend({
        recipient: String(body.recipient || ''),
        text: String(body.text || ''),
        serviceName: body.serviceName,
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
