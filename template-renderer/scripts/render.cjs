#!/usr/bin/env node
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const Mustache = require('mustache');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath, readJsonFile } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs()
  .option('template', { alias: 't', type: 'string', demandOption: true })
  .option('data', { alias: 'd', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' }).argv;

runSkill('template-renderer', () => {
  const templatePath = validateFilePath(argv.template, 'template');
  const template = fs.readFileSync(templatePath, 'utf8');
  const data = readJsonFile(argv.data, 'template data');

  const output = Mustache.render(template, data);

  if (argv.out) {
    safeWriteFile(argv.out, output);
    return { output: argv.out, size: output.length };
  } else {
    return { content: output };
  }
});
