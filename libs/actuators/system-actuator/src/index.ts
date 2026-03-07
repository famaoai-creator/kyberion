import { logger, safeExec, say } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * System-Actuator v1.0.0
 * Unified interface for OS-level peripheral injection (Keyboard, Mouse, Voice).
 */

interface SystemAction {
  action: 'keyboard' | 'mouse' | 'voice' | 'notify';
  target_app?: string;
  keyboard?: { text?: string; keys?: string[]; delay?: number };
  mouse?: { type: 'click' | 'move' | 'scroll'; x?: number; y?: number; button?: 'left' | 'right' };
  voice?: { text: string; persona?: string };
  notify?: { title: string; message: string };
  options?: any;
}

const KEY_MAP: Record<string, number> = {
  'enter': 36, 'return': 36, 'tab': 48, 'esc': 53, 'space': 49, 'backspace': 51,
  'up': 126, 'down': 125, 'left': 123, 'right': 124
};

async function handleAction(input: SystemAction) {
  switch (input.action) {
    case 'keyboard': {
      logger.info(`🎹 [SYSTEM] Injecting keyboard events into ${input.target_app || 'frontmost app'}`);
      const args = input.keyboard || {};
      const app = input.target_app;
      const delay = (args.delay || 50) / 1000;
      let script = app ? `tell application "${app}" to activate\ndelay 0.8\n` : '';
      script += `tell application "System Events"\n`;
      
      if (args.text) {
        for (const char of args.text) {
          const escaped = char.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          script += `  keystroke "${escaped}"\n`;
          if (delay > 0) script += `  delay ${delay}\n`;
        }
      }
      if (args.keys) {
        for (const keyCombo of args.keys) {
          const parts = keyCombo.toLowerCase().split('+');
          const baseKey = parts.pop() || '';
          const modifiers = parts.map(m => {
            if (m === 'command' || m === 'cmd') return 'command down';
            if (m === 'control' || m === 'ctrl') return 'control down';
            if (m === 'option' || m === 'opt') return 'option down';
            if (m === 'shift') return 'shift down';
            return '';
          }).filter(m => m !== '');
          const modString = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
          
          if (KEY_MAP[baseKey]) {
            script += `  key code ${KEY_MAP[baseKey]}${modString}\n`;
          } else if (baseKey.length === 1) {
            script += `  keystroke "${baseKey}"${modString}\n`;
          }
          script += `  delay ${delay}\n`;
        }
      }
      script += `end tell\n`;
      
      safeExec('osascript', ['-e', script]);
      return { status: 'success', executed: 'keyboard_injection' };
    }

    case 'mouse': {
      logger.info(`🖱️ [SYSTEM] Executing mouse action: ${input.mouse?.type}`);
      // AppleScript basic click (for advanced x/y, cliclick or specialized bin is required)
      // This is a minimal fallback implementation for the Actuator
      let mScript = `tell application "System Events" to click at {${input.mouse?.x || 0}, ${input.mouse?.y || 0}}`;
      safeExec('osascript', ['-e', mScript]);
      return { status: 'success', executed: 'mouse_injection' };
    }

    case 'voice': {
      logger.info(`🗣️ [SYSTEM] Synthesizing voice`);
      if (input.voice?.text) {
         // Uses the core library's `say` wrapper
         await say(input.voice.text);
      }
      return { status: 'success', executed: 'voice_synthesis' };
    }

    case 'notify': {
      logger.info(`🔔 [SYSTEM] Displaying OS notification`);
      const nScript = `display notification "${input.notify?.message}" with title "${input.notify?.title}"`;
      safeExec('osascript', ['-e', nScript]);
      return { status: 'success', executed: 'os_notification' };
    }

    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as SystemAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
