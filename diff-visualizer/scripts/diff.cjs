#!/usr/bin/env node
const { safeWriteFile } = require('@agent/core/secure-io');
const fs = require('fs');
const Diff = require('diff');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { validateFilePath } = require('@agent/core/validators');

const argv = createStandardYargs()
  .option('old', { alias: 'a', type: 'string', demandOption: true })
  .option('new', { alias: 'b', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' }).argv;

runSkill('diff-visualizer', () => {
  const oldPath = validateFilePath(argv.old, 'old file');
  const newPath = validateFilePath(argv.new, 'new file');
  const oldText = fs.readFileSync(oldPath, 'utf8');
  const newText = fs.readFileSync(newPath, 'utf8');

  const diff = Diff.createTwoFilesPatch(
    argv.old,
    argv.new,
    oldText,
    newText,
    'Old File',
    'New File'
  );

  if (argv.out) {
    safeWriteFile(argv.out, diff);
    return { output: argv.out, size: diff.length };
  } else {
    return { content: diff };
  }
});
