#!/usr/bin/env node
const path = require('path');
const { runSkill } = require('@agent/core');
const { createStandardYargs } = require('@agent/core/cli-utils');
const { walk } = require('@agent/core/fs-utils');

const argv = createStandardYargs().argv;

runSkill('schema-inspector', () => {
  const rootDir = path.resolve(argv.input || '.');
  const schemas = [];

  for (const filePath of walk(rootDir)) {
    const name = path.basename(filePath);
    if (name.endsWith('.schema.json') || name.endsWith('prisma.schema') || name.endsWith('.sql')) {
      schemas.push({ name, path: path.relative(rootDir, filePath) });
    }
  }

  return { rootDir, schemas, count: schemas.length };
});
