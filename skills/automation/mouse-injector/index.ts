import { logger, runSkillAsync, safeExec, safeReadFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

/**
 * mouse-injector v1.0 (macOS Specialized)
 * Uses AppleScript and small Python3 scripts for mouse control.
 * [SECURE-IO COMPLIANT VERSION]
 */

interface MouseArgs {
  x?: number;
  y?: number;
  click?: 'none' | 'left' | 'right' | 'double';
  drag_to_x?: number;
  drag_to_y?: number;
  scroll?: number;
  input?: string;
}

function generateAppleScript(args: MouseArgs): string {
  let script = 'tell application "System Events"\n';
  const clickType = args.click || 'none';
  if (args.x !== undefined && args.y !== undefined) {
    if (clickType === 'left') {
      script += `  click at {${args.x}, ${args.y}}\n`;
    } else if (clickType === 'double') {
      script += `  click at {${args.x}, ${args.y}}\n`;
      script += `  delay 0.1\n`;
      script += `  click at {${args.x}, ${args.y}}\n`;
    }
  }
  script += 'end tell\n';
  return script;
}

const main = async (args: MouseArgs) => {
  let effectiveArgs = { ...args };
  if (args.input) {
    try {
      const raw = safeReadFile(args.input, { encoding: 'utf8' }) as string;
      effectiveArgs = { ...effectiveArgs, ...JSON.parse(raw) };
    } catch (_) {}
  }

  logger.info(`🖱️ Injecting mouse events...`);

  try {
    if (effectiveArgs.x !== undefined && effectiveArgs.y !== undefined && effectiveArgs.click !== 'none') {
      const script = generateAppleScript(effectiveArgs);
      safeExec('osascript', ['-e', script]);
    }

    if (effectiveArgs.scroll) {
      const scrollScript = `
import sys
try:
    from Quartz.CoreGraphics import CGEventCreateScrollWheelEvent, CGEventPost, kCGHIDEventTap
    def scroll(amount):
        ev = CGEventCreateScrollWheelEvent(None, 0, 1, amount)
        CGEventPost(kCGHIDEventTap, ev)
    scroll(${effectiveArgs.scroll})
except ImportError:
    print("Quartz not found")
    sys.exit(1)
`.trim();
      try {
        safeExec('python3', ['-c', scrollScript]);
      } catch (_) {
        logger.warn('⚠️ Advanced scroll failed. (Requires PyObjC / Python3 Quartz)');
      }
    }

    return {
      status: 'success',
      message: `Successfully injected mouse actions.`,
      details: effectiveArgs
    };
  } catch (err: any) {
    logger.error(`❌ Mouse Injection Failed: ${err.message}`);
    throw new Error(`Accessibility permissions might be missing: ${err.message}`);
  }
};

const argv = createStandardYargs()
  .option('x', { type: 'number' })
  .option('y', { type: 'number' })
  .option('click', { type: 'string', choices: ['none', 'left', 'right', 'double'] })
  .option('scroll', { type: 'number' })
  .option('input', { type: 'string' })
  .parseSync();

runSkillAsync('mouse-injector', () => main(argv as any));
