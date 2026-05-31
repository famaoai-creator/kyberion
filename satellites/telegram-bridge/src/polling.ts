import { safeReadFile, safeExistsSync, pathResolver, logger } from '@agent/core';
import * as path from 'node:path';

const CONNECTIONS_FILE = pathResolver.resolve('knowledge/personal/connections/telegram.json');
const BRIDGE_WEBHOOK_URL = 'http://127.0.0.1:3035/webhook';

async function main() {
  if (!safeExistsSync(CONNECTIONS_FILE)) {
    logger.error('❌ [TelegramPolling] telegram.json not found in Personal connections.');
    process.exit(1);
  }

  const { token } = JSON.parse(safeReadFile(CONNECTIONS_FILE, { encoding: 'utf8' }) as string);
  if (!token) {
    logger.error('❌ [TelegramPolling] Token missing in telegram.json.');
    process.exit(1);
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

      const body = await response.json() as any;
      if (body.ok && Array.isArray(body.result)) {
        for (const update of body.result) {
          offset = Math.max(offset, update.update_id + 1);

          logger.info(`📥 [TelegramPolling] Received update ${update.update_id}, forwarding to webhook...`);
          const forwardRes = await fetch(BRIDGE_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
          });

          if (!forwardRes.ok) {
            const errBody = await forwardRes.text();
            logger.error(`❌ [TelegramPolling] Webhook forward failed: ${forwardRes.status} - ${errBody}`);
          }
        }
      }
    } catch (error: any) {
      logger.error(`❌ [TelegramPolling] Error: ${error?.message || error}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
