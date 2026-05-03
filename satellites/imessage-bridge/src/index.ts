import express from 'express';
import { createStandardYargs, logger, pathResolver, safeReadFile } from '@agent/core';
import { describeIMessageBridgeHealth, sendIMessage, type IMessageSendRequest } from '@agent/core';

interface BridgeInput {
  action?: string;
  recipient?: string;
  text?: string;
  serviceName?: string;
}

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

async function main() {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string' })
    .option('port', { type: 'number', default: Number(process.env.IMESSAGE_BRIDGE_PORT || '3034') })
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

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'imessage-bridge',
      platform: process.platform,
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
