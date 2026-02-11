#!/usr/bin/env node
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk } = require('../../scripts/lib/fs-utils.cjs');

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
