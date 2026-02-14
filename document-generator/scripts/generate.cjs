#!/usr/bin/env node
const { runAsyncSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { execSync } = require('child_process');
const path = require('path');

const argv = createStandardYargs().option('format', {
  alias: 'f',
  type: 'string',
  choices: ['pdf', 'docx', 'xlsx', 'pptx', 'html'],
  demandOption: true,
}).argv;

runAsyncSkill('document-generator', async () => {
  const input = path.resolve(argv.input);
  const output = path.resolve(argv.out);
  const format = argv.format.toLowerCase();

  let scriptPath = '';
  let skillName = '';

  switch (format) {
    case 'pdf':
      scriptPath = 'pdf-composer/scripts/compose.cjs';
      skillName = 'pdf-composer';
      break;
    case 'docx':
      scriptPath = 'word-artisan/scripts/convert.cjs';
      skillName = 'word-artisan';
      break;
    case 'xlsx':
      scriptPath = 'excel-artisan/scripts/html_to_excel.cjs';
      skillName = 'excel-artisan';
      break;
    case 'pptx':
      scriptPath = 'ppt-artisan/scripts/convert.cjs';
      skillName = 'ppt-artisan';
      break;
    case 'html':
      scriptPath = 'html-reporter/scripts/report.cjs';
      skillName = 'html-reporter';
      break;
  }

  console.log(`Routing to specialized skill: ${skillName}...`);

  // Execute the specialized skill script
  const command = `node ${path.join(__dirname, '../../', scriptPath)} --input "${input}" --out "${output}"`;
  const result = execSync(command, { encoding: 'utf8' });

  try {
    return JSON.parse(result).data;
  } catch (_e) {
    return { message: `Document generated successfully at ${argv.out}`, raw: result };
  }
});
