#!/usr/bin/env node
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk } = require('../../scripts/lib/fs-utils.cjs');

const argv = createStandardYargs().argv;

function buildTreeLines(dir, depth = 0) {
    const lines = [];
    const files = walk(dir, { maxDepth: parseInt(process.argv[3] || '3', 10) });

    for (const file of files) {
        const relative = path.relative(dir, file);
        const parts = relative.split(path.sep);
        const indent = '│   '.repeat(parts.length - 1);
        lines.push(`${indent}├── ${parts[parts.length - 1]}`);
    }
    return lines;
}

runSkill('codebase-mapper', () => {
    const rootDir = path.resolve(argv.input || '.');
    const tree = buildTreeLines(rootDir);
    return { root: rootDir, tree };
});