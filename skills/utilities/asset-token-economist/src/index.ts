import * as path from 'node:path';
import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { detectContentType, estimateTokens, pruneContext } from './lib.js';

const argv = createStandardYargs()
  .option('prune', {
    alias: 'p',
    type: 'boolean',
    default: false,
    describe: 'Prune conversational context/history for memory efficiency'
  })
  .option('text', {
    alias: 't',
    type: 'string',
    describe: 'Raw text input for analysis or pruning'
  })
  .parseSync();

runSkill('asset-token-economist', () => {
  let text = '';
  if (argv.input) {
    text = safeReadFile(path.resolve(argv.input as string), 'utf8') as string;
  } else if (argv.text) {
    text = argv.text as string;
  }

  // 1. Handle Pruning if flag is set
  if (argv.prune) {
    if (!text) throw new Error('Pruning requires input via --input or --text.');
    try {
      const messages = JSON.parse(text);
      const { pruned, summary } = pruneContext(messages);
      const tokensBefore = estimateTokens(text, 'prose');
      const tokensAfter = estimateTokens(JSON.stringify(pruned), 'prose');
      
      const result = { 
        pruned, 
        summary, 
        tokensSaved: Math.max(0, tokensBefore - tokensAfter)
      };

      if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
      return result;
    } catch (e) {
      throw new Error(`Failed to prune context: ${(e as Error).message}. Ensure input is a JSON array of messages.`);
    }
  }

  // 2. Default Token Accounting
  const type = detectContentType(text);
  const tokens = estimateTokens(text, type);
  const result = { tokens, contentType: type };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
