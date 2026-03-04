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
    text = safeReadFile(path.resolve(argv.input as string), { encoding: 'utf8' }) as string;
  } else if (argv.text) {
    text = argv.text as string;
  }

  // 1. Handle Pruning if flag is set
  if (argv.prune) {
    if (!text) throw new Error('Pruning requires input via --input or --text.');
    const contentType = detectContentType(text);
    const prunedText = pruneContext(text, 2000, contentType);
    const tokensBefore = estimateTokens(text, contentType);
    const tokensAfter = estimateTokens(prunedText, contentType);
    
    const result = { 
      pruned_text: prunedText, 
      tokens_saved: Math.max(0, tokensBefore - tokensAfter),
      content_type: contentType
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
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
