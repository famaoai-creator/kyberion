import { ReflexTerminal } from '../libs/core/reflex-terminal.js';
import { logger } from '../libs/core/index.js';

async function checkRTMode() {
  logger.info('🔍 Checking ReflexTerminal Real Mode...');
  const rt = new ReflexTerminal({ cols: 80, rows: 24 });
  
  // The constructor logs [RT] Using Native PTY or Emulated Terminal
  // Let's also check if it can run 'ls' and get output
  let hasOutput = false;
  rt.execute('ls -F');
  
  setTimeout(() => {
    rt.kill();
    logger.info('✅ RT Check finished.');
  }, 2000);
}

checkRTMode().catch(console.error);
