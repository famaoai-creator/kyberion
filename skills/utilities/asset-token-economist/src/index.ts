import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { detectContentType, estimateTokens } from './lib.js';

const argv = createStandardYargs().parseSync();

runSkill('asset-token-economist', () => {
  let text = '';
  if (argv.input) {
    text = safeReadFile(path.resolve(argv.input as string), 'utf8');
  }

  const type = detectContentType(text);
  const tokens = estimateTokens(text, type);

  const result = { tokens, contentType: type };

  if (argv.out) {
    safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
  }

  return result;
});
