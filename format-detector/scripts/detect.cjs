#!/usr/bin/env node
const fs = require('fs');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { validateFilePath } = require('../../scripts/lib/validators.cjs');

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).argv;

runSkill('format-detector', () => {
  const inputPath = validateFilePath(argv.input, 'input');
  const content = fs.readFileSync(inputPath, 'utf8');
  let format = 'unknown';
  let confidence = 0.0;

  // Simple heuristic detection
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    try {
      JSON.parse(content);
      format = 'json';
      confidence = 1.0;
    } catch (_e) {}
  }

  if (format === 'unknown') {
    if (content.includes('---') || content.includes(': ')) {
      // Basic YAML check
      format = 'yaml';
      confidence = 0.7;
    } else if (content.includes(',')) {
      // Basic CSV check
      const lines = content.split('\n');
      if (lines.length > 0 && lines[0].split(',').length > 1) {
        format = 'csv';
        confidence = 0.6;
      }
    }
  }

  return { format, confidence };
});
