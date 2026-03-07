import { logger, safeReadFile, safeExec } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';

/**
 * System-Actuator v1.2.0 [PHYSICAL IO ENABLED]
 * Unified interface for OS-level interactions.
 * Strictly compliant with Layer 2 (Shield).
 */

interface SystemAction {
  action: 'keyboard' | 'mouse' | 'voice' | 'notify';
  text?: string;
  key?: string; // For special keys
  priority?: number;
  options?: any;
}

async function handleAction(input: SystemAction) {
  switch (input.action) {
    case 'notify':
      logger.info(`🔔 [SYSTEM] Notification: ${input.text}`);
      if (process.platform === 'darwin') {
        try {
          safeExec('say', [input.text || 'System Notification Received']);
        } catch (_) {}
      }
      return { status: 'notified', text: input.text };

    case 'voice':
      logger.info(`🗣️ [SYSTEM] Speaking: ${input.text}`);
      if (process.platform === 'darwin') {
        safeExec('say', [input.text || 'Voice feedback active']);
      }
      return { status: 'spoken', text: input.text };

    case 'keyboard':
      if (!input.text) throw new Error('text is required for keyboard action.');
      logger.info(`⌨️  [SYSTEM] Typing: ${input.text.substring(0, 20)}...`);
      if (process.platform === 'darwin') {
        const escaped = input.text.replace(/"/g, '\\"');
        safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
      }
      return { status: 'typed', length: input.text.length };

    case 'mouse':
      logger.warn('⚠️ [SYSTEM] Mouse action is currently simulated.');
      return { status: 'simulated', action: 'mouse' };

    default:
      throw new Error(`Unsupported system action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
