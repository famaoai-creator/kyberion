import { logger, runSkillAsync, safeExec, safeReadFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

/**
 * keyboard-injector v1.0 (macOS Specialized)
 * Uses AppleScript (osascript) for high-fidelity system-level keyboard automation.
 * [SECURE-IO COMPLIANT VERSION]
 */

interface InjectArgs {
  text?: string;
  keys?: string[];
  delay?: number;
  application?: string;
  sessionId?: string;
  input?: string;
}

const KEY_MAP: Record<string, number> = {
  'enter': 36,
  'return': 36,
  'tab': 48,
  'esc': 53,
  'space': 49,
  'backspace': 51,
  'up': 126,
  'down': 125,
  'left': 123,
  'right': 124,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111
};

function generateAppleScript(args: InjectArgs): string {
  const app = args.application || 'iTerm2';
  
  const delay = (args.delay || 50) / 1000;
  let script = `tell application "${app}" to activate\n`;
  script += `delay 0.8\n`; 
  script += `tell application "System Events"\n`;
  script += `  if (name of first process whose frontmost is true) is not "${app}" then\n`;
  script += `    log "Safety Triggered: Target application ${app} is not frontmost."\n`;
  script += `    return\n`;
  script += `  end if\n`;

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
  return script;
}

const main = async (args: InjectArgs) => {
  let effectiveArgs = { ...args };
  if (args.input) {
    try {
      const raw = safeReadFile(args.input, { encoding: 'utf8' }) as string;
      effectiveArgs = { ...effectiveArgs, ...JSON.parse(raw) };
    } catch (_) {}
  }

  if (!effectiveArgs.text && (!effectiveArgs.keys || effectiveArgs.keys.length === 0)) {
    throw new Error('Either "text" or "keys" must be provided.');
  }

  const script = generateAppleScript(effectiveArgs);
  logger.info(`🎹 Injecting keyboard events into ${effectiveArgs.application || 'iTerm2'}...`);

  try {
    safeExec('osascript', ['-e', script]);
    
    return {
      status: 'success',
      message: `Successfully injected keystrokes into ${effectiveArgs.application || 'iTerm2'}.`,
      details: {
        text_length: effectiveArgs.text?.length || 0,
        keys_count: effectiveArgs.keys?.length || 0
      }
    };
  } catch (err: any) {
    logger.error(`❌ Keyboard Injection Failed: ${err.message}`);
    throw new Error(`Accessibility permissions might be missing or the application is not responding: ${err.message}`);
  }
};

const argv = createStandardYargs()
  .option('text', { type: 'string' })
  .option('keys', { type: 'array' })
  .option('delay', { type: 'number' })
  .option('application', { type: 'string' })
  .option('input', { type: 'string' })
  .parseSync();

runSkillAsync('keyboard-injector', () => main(argv as any));
