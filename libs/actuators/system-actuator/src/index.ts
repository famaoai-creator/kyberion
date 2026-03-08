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
  key?: string; 
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  priority?: number;
  options?: any;
}

async function handleAction(input: SystemAction) {
  switch (input.action) {
    case 'notify':
      // ... (existing code)
      return { status: 'notified', text: input.text };

    case 'voice':
      // ... (existing code)
      return { status: 'spoken', text: input.text };

    case 'keyboard':
      const textToType = input.text || input.key;
      if (!textToType) throw new Error('text or key is required for keyboard action.');
      logger.info(`⌨️  [SYSTEM] Typing: ${textToType.substring(0, 20)}...`);
      if (process.platform === 'darwin') {
        const escaped = textToType.replace(/"/g, '\\"');
        safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
      }
      return { status: 'typed', text: textToType };

    case 'mouse':
      const { x = 0, y = 0, button = 'left' } = input;
      logger.info(`🖱️ [SYSTEM] Mouse ${button} click at (${x}, ${y})`);
      if (process.platform === 'darwin') {
        // Simple AppleScript for mouse click (Requires accessibility permissions)
        const clickScript = `tell application "System Events" to click at {${x}, ${y}}`;
        try {
          safeExec('osascript', ['-e', clickScript]);
        } catch (err: any) {
          logger.warn(`⚠️ [SYSTEM] Mouse click failed (Check permissions): ${err.message}`);
          return { status: 'failed', reason: 'permission_denied' };
        }
      }
      return { status: 'clicked', x, y, button };

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
