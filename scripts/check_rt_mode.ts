import { ReflexTerminal } from '@agent/core/reflex-terminal';
import { defineScript, isDirectScript } from './lib/harness.js';

async function checkRTMode(print: (value: string) => void): Promise<void> {
  print('🔍 Checking ReflexTerminal Real Mode...');
  const rt = new ReflexTerminal({ cols: 80, rows: 24 });

  // The constructor logs [RT] Using Native PTY or Emulated Terminal
  // Let's also check if it can run 'ls' and get output
  rt.execute('ls -F');

  await new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      try {
        rt.kill();
        print('✅ RT Check finished.');
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 2000);
  });
}

export const runCheckRTMode = defineScript({
  name: 'check:rt-mode',
  flags: [],
  run: (context) => checkRTMode(context.print),
});

if (
  isDirectScript(import.meta.url, 'check_rt_mode.ts') ||
  isDirectScript(import.meta.url, 'check_rt_mode.js')
)
  void runCheckRTMode();
