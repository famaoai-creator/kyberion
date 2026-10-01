import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { resolveSurfaceUrl } from '@agent/core/surface/surface-url';
import { secretGuard } from '@agent/core/secret/secret-guard';
import { defineScript, isDirectScript } from '@agent/core/script-harness';
// C7: shared sequential poll (long-poll contract preserved; see main).
import { startBridgeSequentialPoll } from '../../shared/bridge-poll-loop.js';
import { parsePollingResponse, parsePollingUpdates } from './polling-response.js';

/**
 * Webhook of the local telegram-bridge. The bridge listens on
 * TELEGRAM_BRIDGE_PORT when set (see index.ts), so the poller must forward to
 * that same port; otherwise the surface registry URL applies.
 */
export function resolveTelegramBridgeWebhookUrl(): string {
  const portOverride = getRegisteredEnvText('TELEGRAM_BRIDGE_PORT')?.trim();
  if (portOverride) {
    const port = Number(portOverride);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(
        `[TelegramPolling] TELEGRAM_BRIDGE_PORT must be a TCP port number; got "${portOverride}"`
      );
    }
    return `http://127.0.0.1:${port}/webhook`;
  }
  return `${resolveSurfaceUrl('telegram-bridge')}/webhook`;
}

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

  const bridgeWebhookUrl = resolveTelegramBridgeWebhookUrl();
  logger.info('🚀 [TelegramPolling] Starting Telegram Bot Long-Polling...');
  let offset = 0;

  // C7: shared sequential poll. Contract preserved from the hand-written
  // `while (true)` loop: immediate retry on success, fixed 5s delay on error
  // (the in-body forward-failure log stays non-fatal), plus duplicate-start
  // guard and a stop handle the old loop lacked.
  const loop = startBridgeSequentialPoll({
    name: 'telegram-polling',
    errorDelayMs: 5000,
    onError: (error: unknown) => {
      logger.error(
        `❌ [TelegramPolling] Error: ${error instanceof Error ? error.message : String(error)}`
      );
    },
    poll: async () => {
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
          const forwardRes = await fetch(bridgeWebhookUrl, {
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
    },
  });
  await loop.done;
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
