import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { secretGuard } from '@agent/core/secret-guard';
import { defineScript, isDirectScript } from '@agent/core/script-harness';
import { parsePollingResponse, parsePollingUpdates } from './polling-response.js';
const BRIDGE_WEBHOOK_URL = 'http://127.0.0.1:3035/webhook';

export async function main(_args: string[] = []): Promise<void> {
  const connection = secretGuard.loadConnectionDocument('telegram');
  if (!connection || Object.keys(connection).length === 0) {
    logger.error('❌ [TelegramPolling] telegram.json not found in Personal connections.');
    process.exitCode = 1;
    return;
  }

  const { token } = connection;
  if (!token) {
    logger.error('❌ [TelegramPolling] Token missing in telegram.json.');
    process.exitCode = 1;
    return;
  }

  logger.info('🚀 [TelegramPolling] Starting Telegram Bot Long-Polling...');
  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=10`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Telegram API returned ${response.status}`);
      }

      const body = parsePollingResponse(await response.json());
      if (body.ok) {
        for (const update of parsePollingUpdates(body.result)) {
          offset = Math.max(offset, update.update_id + 1);

          logger.info(
            `📥 [TelegramPolling] Received update ${update.update_id}, forwarding to webhook...`
          );
          const forwardRes = await fetch(BRIDGE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
          });

          if (!forwardRes.ok) {
            const errBody = await forwardRes.text();
            logger.error(
              `❌ [TelegramPolling] Webhook forward failed: ${forwardRes.status} - ${errBody}`
            );
          }
        }
      }
    } catch (error: unknown) {
      logger.error(
        `❌ [TelegramPolling] Error: ${error instanceof Error ? error.message : String(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const directEntry = isDirectScript(import.meta.url, 'satellites/telegram-bridge/src/polling.ts');
export const runTelegramPolling = defineScript({
  name: 'telegram-polling',
  async run({ argv }) {
    await main(argv);
  },
});

if (directEntry && !getRegisteredEnvText('VITEST')) {
  void runTelegramPolling();
}
