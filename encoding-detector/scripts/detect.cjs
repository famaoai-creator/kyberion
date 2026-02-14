#!/usr/bin/env node
const fs = require('fs');
const jschardet = require('jschardet');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { validateFilePath } = require('@agent/core/validators');

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).argv;

runSkill('encoding-detector', () => {
  const inputPath = validateFilePath(argv.input, 'input');
  const buffer = fs.readFileSync(inputPath);
  const result = jschardet.detect(buffer);

  // Check line endings
  const content = buffer.toString();
  let lineEnding = 'unknown';
  if (content.includes('\r\n')) lineEnding = 'CRLF';
  else if (content.includes('\n')) lineEnding = 'LF';
  else if (content.includes('\r')) lineEnding = 'CR';

  return { ...result, lineEnding };
});
