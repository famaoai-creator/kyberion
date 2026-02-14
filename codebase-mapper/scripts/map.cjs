#!/usr/bin/env node
const path = require('path');
const { runSkillAsync } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { walkAsync } = require('@agent/core/fs-utils');

const argv = createStandardYargs().argv;

async function buildTreeLinesAsync(dir) {
  const lines = [];
  const maxDepth = parseInt(process.argv[3] || '3', 10);

  for await (const file of walkAsync(dir, { maxDepth })) {
    const relative = path.relative(dir, file);
    const parts = relative.split(path.sep);
    const indent = '│   '.repeat(parts.length - 1);
    lines.push(`${indent}├── ${parts[parts.length - 1]}`);
  }
  return lines;
}

runSkillAsync('codebase-mapper', async () => {
  const rootDir = path.resolve(argv.input || '.');
  const tree = await buildTreeLinesAsync(rootDir);
  return { root: rootDir, tree };
});
